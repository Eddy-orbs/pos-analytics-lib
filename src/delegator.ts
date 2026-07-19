/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import _ from 'lodash';
import BigNumber from "bignumber.js";
import { bigToNumber, optionsStartFromText, parseOptions } from './helpers';
import { addressToTopic, appendItems, ascendingEvents, Contracts, generateTxLink, getBlockEstimatedTime, getQueryDelegationBlock, getQueryPosBlock, getStartOfPosBlock, getWeb3, getWeb3Polygon, readContractEvents, readDelegatorCurrentDataFromState, readDelegatorDataFromState, Topics } from "./eth-helpers";
import { DelegatorCurrent, DelegatorInfo, DelegatorAction, DelegatorReward, DelegatorStake, PosOptions } from "./model";
import { getDelegatorRewardsStakingInternal, getRewardsClaimActions } from './rewards';

const LEGACY_EVENT_QUERY = {loadHistoricalContractManifest: true};

/**
 * Reads only the Delegator's current contract state.
 *
 * This does not query event logs and therefore does not load actions, stake
 * history or reward history. A string endpoint creates an Ethereum Web3
 * instance; callers querying Polygon should pass a configured Polygon Web3
 * instance.
 */
export async function getDelegatorCurrent(address: string, endpointOrWeb3: string | any): Promise<DelegatorCurrent> {
    const web3 = _.isString(endpointOrWeb3) ? await getWeb3(endpointOrWeb3) : endpointOrWeb3;
    const ethData = await readDelegatorCurrentDataFromState(address, web3);

    return {
        address: address.toLowerCase(),
        block_number: ethData.block.number,
        block_time: ethData.block.time,
        total_stake: bigToNumber(ethData.staked),
        cooldown_stake: bigToNumber(ethData.cooldown_stake),
        current_cooldown_time: ethData.current_cooldown_time,
        non_stake: bigToNumber(ethData.non_stake),
        delegated_to: ethData.guardian,
    };
}

export async function getDelegator(address: string, ethereumEndpoint: string | any, o?: PosOptions | any, refBlock?:{[chainId: number]: {time: number, number: number}}): Promise<DelegatorInfo> {
    const options = parseOptions(o);
    const web3 = _.isString(ethereumEndpoint) ? options.is_polygon ? await getWeb3Polygon(ethereumEndpoint) : await getWeb3(ethereumEndpoint): ethereumEndpoint;
    const actions: DelegatorAction[] = [];
    let stakes: DelegatorStake[] = [];
    let rewards: DelegatorReward[] = [];

    let ethData = await readDelegatorDataFromState(address, web3);
    if (options.read_history) {
        const txs: Promise<any>[] = [
            getStakeActions(address, ethData, web3, options, refBlock).then(res => {
                stakes = res.stakes;
                appendItems(actions, res.stakeActions);
            }),
            getDelegateActions(address, ethData, web3, options, refBlock).then(res => {appendItems(actions, res.delegateActions)}),
        ];
        if(options.read_rewards_disable) {
            txs.push(getRewardsClaimActions(address, ethData, web3, options, false, refBlock).then(res => appendItems(actions, res.claimActions)));
        } else {
            txs.push(getDelegatorRewardsStakingInternal(address, ethData, web3, options, refBlock).then(res =>{
                appendItems(actions, res.claimActions);
                rewards = res.rewards;
            }));
        }
        await Promise.all(txs);
    }

    actions.sort((n1:any, n2:any) => n2.block_number - n1.block_number); // desc unlikely delegator actions in same block

    return {
        address: address.toLowerCase(),
        block_number: ethData.block.number,
        block_time: ethData.block.time,
        read_from_block: optionsStartFromText(options, ethData.block.number),
        total_stake: bigToNumber(ethData.staked),
        cooldown_stake: bigToNumber(ethData.cooldown_stake),
        current_cooldown_time: ethData.current_cooldown_time,
        non_stake: bigToNumber(ethData.non_stake),
        delegated_to: ethData.guardian,
        rewards_balance: bigToNumber(ethData.self_reward_balance),
        rewards_claimed: bigToNumber(ethData.self_reward_claimed),
        total_rewards: bigToNumber(ethData.self_total_rewards),
        stake_slices: stakes,
        actions, 
        reward_slices: rewards
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStakeActions(address:string, ethState:any, web3:any, options: PosOptions, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    let startBlock = getQueryPosBlock(options.read_from_block, ethState.block.number);
    const filter = [undefined /*don't filter event type*/, addressToTopic(address)];
    const events = await readContractEvents(filter, Contracts.Stake, web3, startBlock, 'latest', LEGACY_EVENT_QUERY);
    const chainId = await web3.eth.getChainId();

    let totalStake = new BigNumber(0);
    let coolDownStake = new BigNumber(0);
    const stakeActions: DelegatorAction[] = [];
    const stakes: DelegatorStake[] = [generateStakeAction(ethState.block.number, ethState.block.time, bigToNumber(ethState.staked), bigToNumber(ethState.cooldown_stake))];
    events.sort(ascendingEvents); 
    
    for (let event of events) {
        const amount = new BigNumber(event.returnValues.amount);
        switch (event.signature) { // same as topics[0] same as event type
            case Topics.Staked:
                totalStake = totalStake.plus(amount);
                break;
            case Topics.Restaked:
                totalStake = totalStake.plus(amount)
                coolDownStake = coolDownStake.minus(amount)
                break;
            case Topics.Unstaked:
                totalStake = totalStake.minus(amount)
                coolDownStake = coolDownStake.plus(amount)
                break;
            case Topics.Withdrew:
                coolDownStake = coolDownStake.minus(amount)
                break;
            default:
                continue;
        }
        const blockTime = getBlockEstimatedTime(event.blockNumber, chainId, refBlock)
        stakeActions.push({
            contract: event.address.toLowerCase(),
            event: event.event,
            block_number: event.blockNumber,
            block_time: blockTime,
            tx_hash: event.transactionHash,
            additional_info_link: generateTxLink(event.transactionHash, chainId),
            amount: bigToNumber(amount),
            current_stake: bigToNumber(totalStake),
        });
        stakes.push(generateStakeAction(event.blockNumber, blockTime, bigToNumber(totalStake), bigToNumber(coolDownStake)));
    }

    if (startBlock <= getStartOfPosBlock().number) {
        // fake 'start' of events
        stakes.push(generateStakeAction(getStartOfPosBlock().number, getStartOfPosBlock().time, 0, 0));
    }

    stakes.sort((n1:any, n2:any) => n2.block_number - n1.block_number);  // desc

    return { stakes, stakeActions };
}

function generateStakeAction(block_number: number, block_time: number, stake: number, cooldown: number) : DelegatorStake {
    return { block_number, block_time, stake, cooldown }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getDelegateActions(address:string, ethState:any, web3:any, options: PosOptions, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    let startBlock = getQueryDelegationBlock(options.read_from_block, ethState.block.number);
    const filter = [Topics.Delegated, addressToTopic(address)];
    const events = await readContractEvents(filter, Contracts.Delegate, web3, startBlock, 'latest', LEGACY_EVENT_QUERY);
    const chainId = await web3.eth.getChainId();

    const delegateActions: DelegatorAction[] = [];
    
    for (let event of events) {
        delegateActions.push({
            contract: event.address.toLowerCase(),
            event: event.event,
            block_time: getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
            block_number: event.blockNumber,
            tx_hash: event.transactionHash,
            additional_info_link: generateTxLink(event.transactionHash, chainId),
            to: String(event.returnValues.to).toLowerCase(),
        });
    }

    return { delegateActions };
}
