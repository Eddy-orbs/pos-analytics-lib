/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import _ from 'lodash';
import BigNumber from 'bignumber.js';
import { fetchJson, bigToNumber, parseOptions, optionsStartFromText, querySubgraph} from './helpers';
import { addressToTopic, appendItems, ascendingEvents, Contracts, getBlockEstimatedTime, generateTxLink, getWeb3, readBalances, readContractEvents, readGuardianCurrentDataFromState, readGuardianDataFromState, Topics, getStartOfRewardsBlock, getStartOfPosBlock, getStartOfDelegationBlock, getQueryRewardsBlock, getQueryPosBlock } from "./eth-helpers";
import { Guardian, GuardianCurrent, GuardianInfo, GuardianDelegator, GuardianReward, GuardianStake, GuardianAction, DelegatorReward, PosOptions } from './model';
import { getGuardianRewardsStakingInternal, getRewardsClaimActions } from './rewards';

const LEGACY_EVENT_QUERY = {loadHistoricalContractManifest: true};

export async function getGuardiansCert(networkNodeUrls: string[]) {
    let fullError = '';
    let certs: {[key: string]: boolean } = {}
    for (const url of networkNodeUrls) {
        try {
            const rawData = await fetchJson(url);
            _.forEach(rawData.Payload.Guardians, guardian => {
                certs[guardian.Name] = guardian?.IdentityType === 1;
            });
            return certs;
        } catch (e) {
            fullError += `Warning: access to URL ${url} failed, trying another. Error: ${e}\n`;
        }
    }
    throw new Error(`Error while checking Guardians, all Network Node URL failed to respond. ${fullError}`);
}

export async function getGuardians(networkNodeUrls: string[], ethNodeEndpoints: string[] = []): Promise<Guardian[]> {
    // Certificates for guardians are only available on Ethereum, so in order to fetch this data we need to pass ethNodeEndpoints
    const guardiansCerts = ethNodeEndpoints.length ? await getGuardiansCert(ethNodeEndpoints) : {}
    let fullError = '';
    for(const url of networkNodeUrls) {
        try {
            const rawData = await fetchJson(url);
            return _.map(rawData.Payload.Guardians, (guardian) => {
                return {
                    name: guardian.Name,
                    address: '0x' + String(guardian.EthAddress).toLowerCase(),
                    website: guardian.Website, 
                    effective_stake: Number(guardian?.EffectiveStake || 0),
                    ip: guardian?.Ip || '',
                    certified: guardiansCerts[guardian.Name] || guardian?.IdentityType === 1,
                }
            });
        } catch (e) {
            fullError += `Warning: access to URL ${url} failed, trying another. Error: ${e}\n`;
        }
    }

    throw new Error(`Error while creating list of Guardians, all Netowrk Node URL failed to respond. ${fullError}`);
}

/**
 * Reads only the Guardian's current contract state.
 *
 * This does not query event logs and therefore does not load actions, stake
 * history, reward history or delegators.
 */
export async function getGuardianCurrent(address: string, endpointOrWeb3: string | any): Promise<GuardianCurrent> {
    const web3 = _.isString(endpointOrWeb3) ? await getWeb3(endpointOrWeb3) : endpointOrWeb3;
    const ethData = await readGuardianCurrentDataFromState(address, web3);

    return {
        address: address.toLowerCase(),
        block_number: ethData.block.number,
        block_time: ethData.block.time,
        details: ethData.details,
        stake_status: ethData.stake_status,
        reward_status: ethData.reward_status,
    };
}

export async function getGuardian(address: string, ethereumEndpoint: string | any, o?: PosOptions | any, refBlock?:{[chainId: number]: {time: number, number: number}}): Promise<GuardianInfo> {
    const options = parseOptions(o);
    const actions: GuardianAction[] = [];
    const stakes: GuardianStake[] = [];
    let delegatorMap: {[key:string]: GuardianDelegator} = {};
    let rewardsAsGuardian: GuardianReward[] = [];
    let rewardsAsDelegator: DelegatorReward[] = [];
    let bootstrapRewards: GuardianReward[] = [];
    let feeRewards: GuardianReward[] = [];

    const web3 = _.isString(ethereumEndpoint) ? await getWeb3(ethereumEndpoint) : ethereumEndpoint;
    
    let ethData = await readGuardianDataFromState(address, web3);
    if (options.read_history) {
        const txs: Promise<any>[] = [
            getGuardianStakeAndDelegationChanges(address, ethData, web3, refBlock).then(res => {
                delegatorMap = res.delegatorMap;
                appendItems(actions, res.delegateActions);
                appendItems(stakes, res.delegationStakes);                        
            }),
            getGuardianStakeActions(address, ethData, web3, options, refBlock).then(res => {
                appendItems(actions, res.stakeActions);
                appendItems(stakes, res.stakesBeforeDelegation);
            }),
            getGuardianRegisterationActions(address, ethData, web3, options, refBlock).then(res => {appendItems(actions, res);}),
            getGuardianFeeAndBootstrap(address, ethData, web3, options, refBlock).then(res => {
                appendItems(actions, res.withdrawActions);
                bootstrapRewards = res.bootstraps;
                feeRewards = res.fees;
            })
        ];

        if(options.read_rewards_disable) {
            txs.push(getRewardsClaimActions(address, ethData, web3, options, true).then(res => appendItems(actions, res.claimActions)));
        } else {
            txs.push(getGuardianRewardsStakingInternal(address, ethData, web3, options).then(res =>{
                appendItems(actions, res.claimActions);
                rewardsAsGuardian = res.rewardsAsGuardian;
                rewardsAsDelegator = res.rewardsAsDelegator;
            }));
        }
        await Promise.all(txs);
    }
 
    actions.sort((n1:any, n2:any) => n2.block_number - n1.block_number); // desc unlikely guardian actions in same block
    stakes.sort((n1:any, n2:any) => n2.block_number - n1.block_number); // desc before delegation unlikely in same block. after delegation we filter same block
    
    const delegators = _.map(_.pickBy(delegatorMap, (d) => {return d.stake !== 0}), v => v).sort((n1:any, n2:any) => n2.stake - n1.stake);
    const delegators_left = _.map(_.pickBy(delegatorMap, (d) => {return d.stake === 0}), v => v);

    return {
        address: address.toLowerCase(),
        block_number: ethData.block.number,
        block_time: ethData.block.time,
        read_from_block: optionsStartFromText(options, ethData.block.number),
        details : ethData.details,
        stake_status: ethData.stake_status,
        reward_status: ethData.reward_status,
        actions,
        stake_slices: stakes,
        reward_as_guardian_slices: rewardsAsGuardian,
        reward_as_delegator_slices: rewardsAsDelegator,
        bootstrap_slices: bootstrapRewards, 
        fees_slices: feeRewards,
        delegators,
        delegators_left,
    };
}

export async function getDelegators(address: string, ethereumEndpoint: string | any, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const web3 = _.isString(ethereumEndpoint) ? await getWeb3(ethereumEndpoint) : ethereumEndpoint;
    let ethData = await readGuardianDataFromState(address, web3);
    const delegationChanges = await getGuardianStakeAndDelegationChanges(address, ethData, web3, refBlock)
    const delegatorMap: {[key:string]: GuardianDelegator} = delegationChanges.delegatorMap
    return _.map(_.pickBy(delegatorMap, (d) => {return d.stake !== 0}), v => v).sort((n1:any, n2:any) => n2.stake - n1.stake);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuardianStakeAndDelegationChanges(address: string, ethState:any, web3:any, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const filter = [[Topics.DelegateStakeChanged], addressToTopic(address)];
    const events = await readContractEvents(filter, Contracts.Delegate, web3, undefined, 'latest', LEGACY_EVENT_QUERY);

    const delegatorMap: {[key:string]: GuardianDelegator} = {};
    const delegationStakes: GuardianStake[] = [];
    const delegateActions: GuardianAction[] = [];
    events.sort(ascendingEvents);
    const chainId = await web3.eth.getChainId();

    // handling delegation events using subgraph
    for (let event of events) {
        const delegatorAddress = event.returnValues.delegator.toLowerCase();
        if (delegatorAddress !== address) {
            const d = {
                last_change_block: event.blockNumber,
                last_change_time: 0,
                address: delegatorAddress,
                stake: bigToNumber(new BigNumber(event.returnValues.delegatorContributedStake)),
                non_stake: 0,
            }
            delegatorMap[delegatorAddress] = d;
        }
        const selfDelegate = new BigNumber(event.returnValues.selfDelegatedStake);
        const allStake = new BigNumber(event.returnValues.delegatedStake);

        addOrUpdateStakeList(delegationStakes, event.blockNumber, bigToNumber(selfDelegate), bigToNumber(allStake.minus(selfDelegate)), _.size(delegatorMap), chainId, refBlock);
    }

    const delegatedQuery = `
        query ($address: Bytes!) {
            delegateds(where: { to: $address }, orderBy: blockNumber, orderDirection: asc) {
                id
                from
                to
                blockNumber
                blockTimestamp
                transactionHash
            }
        }
        `;
    const delegatedEvents = await querySubgraph(chainId, delegatedQuery, {address: address.toLowerCase()});
    for (let event of delegatedEvents) {
        const toAddress = event.to.toLowerCase();
        delegateActions.push({
            contract: Contracts.Delegate.toLowerCase(),
            event: toAddress === address.toLowerCase() ? 'SelfDelegated' : 'Delegated',
            block_time: Number(event.blockTimestamp),
            block_number: Number(event.blockNumber),
            tx_hash: event.transactionHash,
            additional_info_link: generateTxLink(event.transactionHash, chainId),
            to: toAddress,
        });
    }

    delegationStakes.push(generateStakeAction(ethState.block.number, ethState.block.time, 
        ethState.stake_status.self_stake, ethState.stake_status.delegate_stake, ethState.stake_status.total_stake, _.size(delegatorMap)));
    
    const balanceMap = await readBalances(_.keys(delegatorMap), web3);
    _.forOwn(delegatorMap, (v) => {
        v.last_change_time = getBlockEstimatedTime(v.last_change_block, chainId, refBlock);
        v.non_stake = balanceMap[v.address];
    });

    return { delegationStakes, delegatorMap, delegateActions };
}

function addOrUpdateStakeList(stakes: GuardianStake[], blockNumber: number, selfStake: number, delegateStake: number, nDelegators: number, chainId: number, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    if (stakes.length > 0 && stakes[stakes.length-1].block_number == blockNumber) {
        const curr = stakes[stakes.length-1];
        curr.self_stake = selfStake;
        curr.delegated_stake = delegateStake;
        curr.total_stake = selfStake + delegateStake;
        curr.n_delegates = nDelegators;
    } else {
        stakes.push(generateStakeAction(blockNumber, getBlockEstimatedTime(blockNumber, chainId, refBlock),
            selfStake, delegateStake, selfStake + delegateStake, nDelegators));
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuardianStakeActions(address: string, ethState:any, web3:any, options: PosOptions,  refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const startBlock = getQueryPosBlock(options.read_from_block, ethState.block.number)
    const filter = [[Topics.Staked, Topics.Restaked, Topics.Unstaked, Topics.Withdrew], addressToTopic(address)];
    const events = await readContractEvents(filter, Contracts.Stake, web3, startBlock, 'latest', LEGACY_EVENT_QUERY);
    events.sort(ascendingEvents);

    let totalStake = new BigNumber(0);
    const stakesBeforeDelegation: GuardianStake[] = [];
    const stakeActions: GuardianAction[] = [];
    const chainId = await web3.eth.getChainId();
    for (let event of events) {
        const amount = new BigNumber(event.returnValues.amount);
        if (event.signature === Topics.Staked || event.signature === Topics.Restaked) {
            totalStake = totalStake.plus(amount);
        } else if (event.signature === Topics.Unstaked) {
            totalStake = totalStake.minus(amount)
        }

        stakeActions.push({
            contract: event.address.toLowerCase(),
            event: event.event,
            block_number: event.blockNumber,
            block_time: getBlockEstimatedTime(event.blockNumber, chainId),
            tx_hash: event.transactionHash,
            additional_info_link: generateTxLink(event.transactionHash, chainId),
            amount: bigToNumber(amount),
            current_stake: bigToNumber(totalStake)
        });

        if(event.blockNumber < getStartOfDelegationBlock().number) {
            stakesBeforeDelegation.push(generateStakeAction(event.blockNumber, getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
                bigToNumber(totalStake), 0, bigToNumber(totalStake), 0));
        }
    }

    if (startBlock <= getStartOfPosBlock().number) {
        // fake 'start' of events
        stakesBeforeDelegation.push(generateStakeAction(getStartOfPosBlock().number, getStartOfPosBlock().time, 0, 0, 0, 0));
    }

    return { stakeActions, stakesBeforeDelegation };
}

function generateStakeAction(block_number: number, block_time: number, self_stake: number, delegated_stake: number, total_stake: number, n_delegates: number) : GuardianStake {
    return { block_number, block_time, self_stake, delegated_stake, total_stake, n_delegates };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuardianRegisterationActions(address: string, ethState:any, web3:any, options: PosOptions, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const startBlock = getQueryPosBlock(options.read_from_block, ethState.block.number)
    const filter = [Topics.GuardianRegisterd, addressToTopic(address)];
    const events = await readContractEvents(filter, Contracts.Guardian, web3, startBlock, 'latest', LEGACY_EVENT_QUERY);
    const chainId = await web3.eth.getChainId();

    const actions: GuardianAction[] = [];    
    for (let event of events) {
        actions.push({
            contract: event.address.toLowerCase(),
            event: event.event,
            block_number: event.blockNumber,
            block_time: getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
            tx_hash: event.transactionHash,
            additional_info_link: generateTxLink(event.transactionHash, chainId),
        });
    }

    return actions;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuardianFeeAndBootstrap(address: string, ethState:any, web3:any, options: PosOptions, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const chainId = await web3.eth.getChainId();
    const startBlock = getQueryRewardsBlock(options.read_from_block, ethState.block.number)
    const fees: GuardianReward[] = [generateRewardItem(ethState.block.number, ethState.block.time, '', ethState.reward_status.fees_balance + ethState.reward_status.fees_claimed, chainId)];
    const bootstraps: GuardianReward[] = [generateRewardItem(ethState.block.number, ethState.block.time, '', ethState.reward_status.bootstrap_balance + ethState.reward_status.bootstrap_claimed, chainId)];
    const withdrawActions: GuardianAction[] = [];

    const filter = [[Topics.BootstrapRewardAssigned, Topics.FeeAssigned, Topics.BootstrapWithdrawn, Topics.FeeWithdrawn], addressToTopic(address)];
    const events = await readContractEvents(filter, Contracts.FeeBootstrapReward, web3, startBlock, 'latest', LEGACY_EVENT_QUERY);
    events.sort((n1:any, n2:any) => n2.blockNumber - n1.blockNumber);  // desc

    for (let event of events) {
        if (event.signature ===  Topics.BootstrapRewardAssigned) {
            bootstraps.push(generateRewardItem(event.blockNumber, getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
                event.transactionHash, bigToNumber(new BigNumber(event.returnValues.totalAwarded)), chainId));
        } else if (event.signature ===  Topics.FeeAssigned) {
            fees.push(generateRewardItem(event.blockNumber, getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
                event.transactionHash, bigToNumber(new BigNumber(event.returnValues.totalAwarded)), chainId));
        } else if (event.signature ===  Topics.BootstrapWithdrawn || event.signature ===  Topics.FeeWithdrawn) {
            withdrawActions.push({
                contract: event.address.toLowerCase(),
                event: event.event,
                block_number: event.blockNumber,
                block_time: getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
                tx_hash: event.transactionHash,
                additional_info_link: generateTxLink(event.transactionHash, chainId),
                amount: bigToNumber(new BigNumber(event.returnValues.amount)),
            });
        }
    }

    if (startBlock <= getStartOfRewardsBlock().number) {
        // fake 'start' of events
        fees.push(generateRewardItem(getStartOfRewardsBlock().number, getStartOfRewardsBlock().time, '', 0, chainId));
        bootstraps.push(generateRewardItem(getStartOfRewardsBlock().number, getStartOfRewardsBlock().time, '', 0, chainId));
    }

    return { bootstraps, fees, withdrawActions };
}

function generateRewardItem(block_number: number, block_time: number, tx_hash: string, total_awarded: number, chainId: number) {
    return {
        block_number,
        block_time,
        tx_hash,
        additional_info_link: tx_hash !== '' ? generateTxLink(tx_hash, chainId) : '',
        total_awarded, 
    };
}
