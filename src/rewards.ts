/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import _ from 'lodash';
import BigNumber from 'bignumber.js';
import { bigToNumber, parseOptions } from './helpers';
import { addressToTopic, appendItems, ascendingEvents, descendingEvents, Contracts, descendingBlockNumbers, generateTxLink, getBlockEstimatedTime, getQueryRewardsBlock, getStartOfRewardsBlock, getWeb3, readContractEvents, readDelegatorDataFromState, readGuardianDataFromState, Topics } from "./eth-helpers";
import { Action, DelegatorReward, GuardianReward, PosOptions} from './model';

const LEGACY_EVENT_QUERY = {loadHistoricalContractManifest: true};

export async function getGuardianStakingRewards(address: string, ethereumEndpoint: string | any, options?: PosOptions | any): Promise<{rewardsAsGuardian: GuardianReward[];rewardsAsDelegator: DelegatorReward[];claimActions: Action[];}> {
    const web3 = _.isString(ethereumEndpoint) ? await getWeb3(ethereumEndpoint) : ethereumEndpoint;  
    const ethData = await readGuardianDataFromState(address, web3);
    return getGuardianRewardsStakingInternal(address, ethData , web3, parseOptions(options));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getGuardianRewardsStakingInternal(address: string, ethState:any, web3:any, options: PosOptions): Promise<{rewardsAsGuardian: GuardianReward[];rewardsAsDelegator: DelegatorReward[];claimActions: Action[];}> {
    const stateData = getStateData(address, ethState, options, true);
    const chainId = await web3.eth.getChainId();

    // read events
    const txs: Promise<any>[] = [
        readContractEvents([[Topics.GuardianRewardAssigned, Topics.DelegatorRewardAssigned, Topics.StakingRewardsClaimed], addressToTopic(stateData.gAddress)], Contracts.Reward, web3, stateData.startBlockNumber, stateData.endBlockNumber, LEGACY_EVENT_QUERY),
        readContractEvents([Topics.StakingRewardAllocated], Contracts.Reward, web3, stateData.startBlockNumber, stateData.endBlockNumber, LEGACY_EVENT_QUERY)
    ];
    const res = await Promise.all(txs);

    //sort and filter
    const {guardianEvents, delegatorEvents, delegationChanges} = filterRewardsEvents(res[0], stateData);
    const claimActions = filterClaimActions(res[0], true, chainId);
    const globalEvents = uniqueBlockEvents(res[1]);

    // generate rewards as Guardian
    let guardianRewardEvents = mergeAndUniqueOfTwoEventLists(guardianEvents, globalEvents);
    const rewardsAsGuardian: GuardianReward[] = generateGuardianRewards(guardianRewardEvents, stateData, chainId);
 
    // generte rewards as Delegator
    if (delegationChanges.length !== 1) { // used to be a "real" delegator so need to find older guardians' events
        const allGuardiansEvents = await generateAllDelegatorGuardiansEvents(delegationChanges, web3);
        guardianRewardEvents = mergeAndUniqueOfTwoEventLists(allGuardiansEvents, globalEvents);
    }
    const rewardsAsDelegator: DelegatorReward[] = generateDelegatorRewards(delegatorEvents, guardianRewardEvents, stateData, chainId);

    return { rewardsAsGuardian, rewardsAsDelegator, claimActions };
}

export async function getDelegatorStakingRewards(address: string, ethereumEndpoint: string | any, options?: PosOptions | any): Promise<{rewards: DelegatorReward[];claimActions: Action[];}> {
    const web3 = _.isString(ethereumEndpoint) ? await getWeb3(ethereumEndpoint) : ethereumEndpoint;  
    const ethData = await readDelegatorDataFromState(address, web3);
    return getDelegatorRewardsStakingInternal(address, ethData , web3, parseOptions(options));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getDelegatorRewardsStakingInternal(address: string, ethState:any, web3:any, options: PosOptions, refBlock?:{[chainId: number]: {time: number, number: number}}): Promise<{rewards: DelegatorReward[];claimActions: Action[];}> {
    const stateData = getStateData(address, ethState, options, false);
    const chainId = await web3.eth.getChainId();

    // read all events
    let txs: Promise<any>[] = [
        readContractEvents([[Topics.DelegatorRewardAssigned, Topics.StakingRewardsClaimed], addressToTopic(address)], Contracts.Reward, web3, stateData.startBlockNumber, stateData.endBlockNumber, LEGACY_EVENT_QUERY),
        readContractEvents([Topics.StakingRewardAllocated], Contracts.Reward, web3, stateData.startBlockNumber, stateData.endBlockNumber, LEGACY_EVENT_QUERY)
    ];
    let res = await Promise.all(txs);

    // sorting and filtering and separate to groups
    const {delegatorEvents, delegationChanges} = filterRewardsEvents(res[0], stateData);
    const claimActions = filterClaimActions(res[0], false, chainId, refBlock);
    const globalEvents = uniqueBlockEvents(res[1]);

    const guardiansEvents = await generateAllDelegatorGuardiansEvents(delegationChanges, web3);
    const guardianAndGlobalEvents = mergeAndUniqueOfTwoEventLists(guardiansEvents, globalEvents);

    // generate the rewards
    const rewards: DelegatorReward[] = generateDelegatorRewards(delegatorEvents, guardianAndGlobalEvents, stateData, chainId, refBlock);

    return { rewards, claimActions };
}

// special case for the "fast" getDelegator/getGuardian version
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getRewardsClaimActions(address: string, ethState:any, web3:any, options: PosOptions, isGuardian: boolean, refBlock?:{[chainId: number]: {time: number, number: number}}): Promise<{claimActions: Action[]}> {
    const startBlock = getQueryRewardsBlock(options.read_from_block, ethState.block.number)
    const events = await readContractEvents([Topics.StakingRewardsClaimed, addressToTopic(address)], Contracts.Reward, web3, startBlock, 'latest', LEGACY_EVENT_QUERY);
    const chainId = await web3.eth.getChainId();
    return {claimActions: filterClaimActions(events, isGuardian, chainId, refBlock)};
}

// creates 3 new lists:
// guardianAssign (only first in each block)
// delegatorAssign (only first in each block)
// delegationChanges list of all the guardians and from/to of delegation
function filterRewardsEvents(events:any[], stateData: RewardStateData) {
    events.sort(descendingEvents);
    const guardianEvents: any[] = [];
    const delegatorEvents: any[] = [];
    const delegationChanges: DelegatorGuardianTransitions[] = [];

    const startBlock = stateData.startBlockNumber;
    delegationChanges.push({guardianAddress: stateData.gAddress, from: startBlock, to: stateData.endBlockNumber});
    let dChangeIndex = 0;

    for(const event of events) {
        if (event.signature === Topics.GuardianRewardAssigned) {
            const last = guardianEvents.length;
            if (last === 0 || guardianEvents[last-1].blockNumber > event.blockNumber) {
                guardianEvents.push(event);
            }
        } else if (event.signature === Topics.DelegatorRewardAssigned) {
            const last = delegatorEvents.length;
            if (last === 0 || delegatorEvents[last-1].blockNumber > event.blockNumber) {
                delegatorEvents.push(event);
                const guardian = new String(event.returnValues.guardian).toLowerCase();
                if (delegationChanges[dChangeIndex].guardianAddress !== guardian) {
                    delegationChanges[dChangeIndex].from = event.blockNumber + 1;
                    delegationChanges.push({guardianAddress: guardian, from: startBlock, to: event.blockNumber});
                    dChangeIndex++;
                }
            }
        }
    }
    
    return {guardianEvents, delegatorEvents, delegationChanges};
}

function filterClaimActions(events:any[], isGuardian: boolean, chainId: number, refBlock?:{[chainId: number]: {time: number, number: number}}): Action[] {
    const claimActions: Action[] = [];
    _.map(events, e => {
        if (e.signature === Topics.StakingRewardsClaimed) {
            if (isGuardian) {
                claimActions.push(generateClaimAction(e, true, chainId, refBlock));
            }
            claimActions.push(generateClaimAction(e, false, chainId, refBlock));
        }
    });
    return claimActions;
}

function generateClaimAction(event:any, isGuardian:boolean, chainId: number, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    return {
        contract: event.address.toLowerCase(),
        event: (isGuardian ? 'Guardian' : 'Delegator') + event.event,
        block_number: event.blockNumber,
        block_time: getBlockEstimatedTime(event.blockNumber, chainId, refBlock),
        tx_hash: event.transactionHash,
        additional_info_link: generateTxLink(event.transactionHash, chainId),
        amount: bigToNumber(new BigNumber(
            isGuardian ? event.returnValues.claimedGuardianRewards : event.returnValues.claimedDelegatorRewards)),
    }
}

async function generateAllDelegatorGuardiansEvents(guardians:DelegatorGuardianTransitions[], web3:any) {
    const txs = []; 
    for (const guardian of guardians) {
        txs.push(readContractEvents([Topics.GuardianRewardAssigned, addressToTopic(guardian.guardianAddress)], Contracts.Reward, web3, guardian.from, guardian.to, LEGACY_EVENT_QUERY))
    }
    const res = await Promise.all(txs);
    
    const allGuardiansEvents: any[] = [];
    for (const list of res) {
        appendItems(allGuardiansEvents, list);
    }

    uniqueBlockEvents(allGuardiansEvents);
    return allGuardiansEvents;
}

// merge two list of events (each one already unique in it's own block-number) the first list events trump the second 
// return descending by block number
function mergeAndUniqueOfTwoEventLists(leadEvents:any[], followerEvents:any[]){
    const events = [...leadEvents, ...followerEvents].sort(descendingBlockNumbers);
    if (leadEvents.length === 0 || followerEvents.length === 0) {
        return events;
    }
    const leaderEvent:string = leadEvents[0].signature;
    let resultSize = 0;
    let i = 0;
    for(;i < events.length-1;i++) {
        if (events[i].blockNumber === events[i+1].blockNumber) {
            if (events[i].signature === leaderEvent) {
                events[resultSize] = events[i];
            } else {
                events[resultSize] = events[i+1];
            }
            i++;
        } else {
            events[resultSize] = events[i];
        }
        resultSize++;        
    }
    if (i < events.length) {
        events[resultSize] = events[i];
        resultSize++;        
    }

    events.length = resultSize; // resize
    return events;
}

// function sorts & resizes the events to hold only the first one in each block.
function uniqueBlockEvents(events:any[]) {
    if (events.length < 2) return events;

    events.sort(ascendingEvents);
    let lastUniqueEventIndex = 0;
    for (let i = 1; i < events.length;i++) {
        if (events[lastUniqueEventIndex].blockNumber >= events[i].blockNumber) {
            continue;
        }
        lastUniqueEventIndex++;
        events[lastUniqueEventIndex] = events[i];
    }

    events.length = lastUniqueEventIndex + 1; // resize
    return events;
}

function generateGuardianRewards(events:any[], stateData: RewardStateData, chainId: number, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const rewardsAsGuardian: GuardianReward[] = [];

    let totalAwarded = stateData.gTotalAwarded;
    let deltaAwarded = stateData.gLastAwarded;
    let deltaRPW = stateData.gDeltaRPW;
    let RPW =  stateData.gRPW;

    // from state 'fake now' reward event
    rewardsAsGuardian.push(generateGuardianReward(stateData.endBlockNumber, '', totalAwarded, chainId, refBlock))

    for (const event of events) {
        if (event.signature ===  Topics.GuardianRewardAssigned) {
            totalAwarded = new BigNumber(event.returnValues.totalAwarded);
            deltaAwarded = new BigNumber(event.returnValues.amount);
            deltaRPW = new BigNumber(event.returnValues.stakingRewardsPerWeightDelta);
            RPW = new BigNumber(event.returnValues.stakingRewardsPerWeight);
        } else {
            if (!deltaRPW.isZero()) {
                const currDeltaAwarded = deltaAwarded.multipliedBy(
                    RPW.minus(new BigNumber(event.returnValues.stakingRewardsPerWeight)).dividedBy(deltaRPW)
                );

                totalAwarded = totalAwarded.minus(currDeltaAwarded);
                deltaAwarded = deltaAwarded.minus(currDeltaAwarded);
            }
            const currRPW = new BigNumber(event.returnValues.stakingRewardsPerWeight);
            deltaRPW = deltaRPW.minus(RPW).plus(currRPW);
            RPW = currRPW;
        }
        rewardsAsGuardian.push(generateGuardianReward(event.blockNumber, event.transactionHash, totalAwarded, chainId, refBlock));
    }

    if (stateData.startBlockNumber <= getStartOfRewardsBlock().number) {
        // fake 'start' of events
        rewardsAsGuardian.push(generateGuardianReward(getStartOfRewardsBlock().number, '', new BigNumber(0), chainId, refBlock))
    }

    return rewardsAsGuardian;
}

function generateGuardianReward(blockNumber:number, txHash:string, totalAwarded:BigNumber, chainId:number, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    return {
        block_number: blockNumber,
        block_time: getBlockEstimatedTime(blockNumber, chainId, refBlock),
        tx_hash: txHash,
        additional_info_link: txHash !== '' ? generateTxLink(txHash, chainId) : '',
        total_awarded: bigToNumber(totalAwarded), 
    }
}

function generateDelegatorRewards(delegatorEvents:any[], guardianGlobalEvents:any[], stateData: RewardStateData, chainId:number, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    const rewardsAsDelegator: DelegatorReward[] = [];

    delegatorEvents.sort(descendingBlockNumbers);
    const gRPTEvents = generateGuardianRPTEventsForDelegator(guardianGlobalEvents, stateData)

    let totalAwarded = stateData.dTotalAwarded;
    let awarded = stateData.dLastAwarded;
    let deltaRPT = stateData.dDeltaRPT;
    let guardianRPT = stateData.gRPT;
    let guardian = stateData.gAddress;
 
    // from state 'fake now' reward event
    rewardsAsDelegator.push(generateDelegatorReward(stateData.endBlockNumber, '', guardian, totalAwarded, chainId, refBlock))
    
    let gDeltaRPTIndex = 0;
    for (const event of delegatorEvents) {
        for(;gDeltaRPTIndex < gRPTEvents.length;gDeltaRPTIndex++) {
            const nextBlockGuardianRPT = guardianRPT;
            guardianRPT = gRPTEvents[gDeltaRPTIndex].RPT;
            if (gRPTEvents[gDeltaRPTIndex].blockNumber === event.blockNumber) {
                gDeltaRPTIndex++;
                break;
            }
            if (!deltaRPT.isZero()) {
                const deltaAwarded = nextBlockGuardianRPT.minus(guardianRPT).multipliedBy(awarded).dividedBy(deltaRPT);
                totalAwarded = totalAwarded.minus(deltaAwarded);
                rewardsAsDelegator.push(generateDelegatorReward(gRPTEvents[gDeltaRPTIndex].blockNumber, gRPTEvents[gDeltaRPTIndex].transactionHash, guardian, totalAwarded, chainId, refBlock));
            }
        }
        totalAwarded = new BigNumber(event.returnValues.totalAwarded);
        guardian = new String(event.returnValues.guardian).toLowerCase();
        awarded = new BigNumber(event.returnValues.amount);
        deltaRPT = new BigNumber(event.returnValues.delegatorRewardsPerTokenDelta);
        rewardsAsDelegator.push(generateDelegatorReward(event.blockNumber, event.transactionHash, guardian, totalAwarded, chainId, refBlock));
    }
    // finish off left over guardian events
    if (!deltaRPT.isZero()) {
        for(;gDeltaRPTIndex < gRPTEvents.length;gDeltaRPTIndex++) {
            const nextBlockGuardianRPT = guardianRPT;
            guardianRPT = gRPTEvents[gDeltaRPTIndex].RPT;
            const deltaAwarded = nextBlockGuardianRPT.minus(guardianRPT).multipliedBy(awarded).dividedBy(deltaRPT);
            totalAwarded = totalAwarded.minus(deltaAwarded);
            rewardsAsDelegator.push(generateDelegatorReward(gRPTEvents[gDeltaRPTIndex].blockNumber, gRPTEvents[gDeltaRPTIndex].transactionHash, guardian, totalAwarded, chainId, refBlock));
        }
    }

    if (stateData.startBlockNumber <= getStartOfRewardsBlock().number) {
        // fake 'start' of events
        rewardsAsDelegator.push(generateDelegatorReward(getStartOfRewardsBlock().number, '', guardian, new BigNumber(0), chainId));
    }

    return rewardsAsDelegator;
}

function generateDelegatorReward(blockNumber:number, txHash:string, guardian:string, totalAwarded:BigNumber, chainId:number, refBlock?:{[chainId: number]: {time: number, number: number}}) {
    return {
        block_number: blockNumber,
        block_time: getBlockEstimatedTime(blockNumber, chainId, refBlock),
        tx_hash: txHash,
        additional_info_link: txHash !== '' ? generateTxLink(txHash, chainId) : '',
        total_awarded: bigToNumber(totalAwarded), 
        guardian_from: guardian,
    }
}

function generateGuardianRPTEventsForDelegator(events:any[], stateData: RewardStateData) {
    const rptList: any[] = [];

    let deltaRPW = stateData.gDeltaRPW as BigNumber;
    let RPW =  stateData.gRPW as BigNumber;
    let deltaRPT = stateData.gDeltaRPT as BigNumber;
    let RPT =  stateData.gRPT as BigNumber;

    for (const event of events) {
        if (event.signature ===  Topics.GuardianRewardAssigned) {
            deltaRPW = new BigNumber(event.returnValues.stakingRewardsPerWeightDelta);
            RPW = new BigNumber(event.returnValues.stakingRewardsPerWeight);
            deltaRPT = new BigNumber(event.returnValues.delegatorRewardsPerTokenDelta);
            RPT = new BigNumber(event.returnValues.delegatorRewardsPerToken);
        } else {
            const currRPW = new BigNumber(event.returnValues.stakingRewardsPerWeight);
            if (!deltaRPW.isZero()) {
                const eventAddedRPT = RPW.minus(currRPW).multipliedBy(deltaRPT).dividedBy(deltaRPW);
                deltaRPW = deltaRPW.minus(RPW).plus(currRPW);
                deltaRPT = deltaRPT.minus(eventAddedRPT);
                RPT = RPT.minus(eventAddedRPT);
            }
            RPW = currRPW;
        }

        if (!deltaRPW.isZero()) {
            rptList.push(generateRPTEvent(event.blockNumber, event.transactionHash, RPT));
        }
     }

    return rptList;
}

function generateRPTEvent(blockNumber:number, transactionHash:string, RPT:BigNumber) {
    return { blockNumber, transactionHash, RPT }
}

interface DelegatorGuardianTransitions {
    guardianAddress: string;
    from: number;
    to: number;
}

function getStateData(address: string, ethState:any, options: PosOptions, isGuardian: boolean): RewardStateData{
    return {
        startBlockNumber: getQueryRewardsBlock(options.read_from_block, ethState.block.number),
        endBlockNumber: ethState.block.number,
        isGuardian,
        // values "as delegator"
        dAddress: address.toLowerCase(),
        dTotalAwarded: ethState.self_total_rewards as BigNumber,
        dLastAwarded: ethState.self_last_rewarded as BigNumber,
        dDeltaRPT: ethState.delegator_delta_RPT as BigNumber,
        dRPT: ethState.delegator_RPT as BigNumber,
        // values "as guardian"
        gTotalAwarded: isGuardian ? ethState.total_rewards as BigNumber : new BigNumber(0),
        gLastAwarded: isGuardian ? ethState.last_rewarded as BigNumber : new BigNumber(0),
        gDeltaRPW: ethState.guardian_delta_RPW as BigNumber,
        gRPW: ethState.guardian_RPW as BigNumber,
        gRPT: ethState.guardian_RPT as BigNumber,
        gDeltaRPT: ethState.guardian_delta_RPT as BigNumber,
        gAddress: ethState.guardian as string,
    }
}

interface RewardStateData {
    startBlockNumber: number;
    endBlockNumber: number;
    isGuardian: boolean;
    // values "as delegator"
    dAddress: string;
    dTotalAwarded: BigNumber;
    dLastAwarded: BigNumber;
    dDeltaRPT: BigNumber;
    dRPT: BigNumber;
    // values "as guardian"
    gTotalAwarded: BigNumber;
    gLastAwarded: BigNumber;
    gDeltaRPW: BigNumber;
    gRPW: BigNumber;
    gRPT: BigNumber;
    gDeltaRPT: BigNumber;
    gAddress: string;
}
