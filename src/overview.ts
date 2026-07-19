/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import _ from 'lodash';
import { Contracts, getBlockEstimatedTime, getStartOfDelegationBlock, getWeb3, readBalances, readContractEvents, readOverviewDataFromState, readStakes, Topics } from "./eth-helpers";
import { fetchJson } from './helpers';
import { PosOverview, PosOverviewSlice, PosOverviewData, Delegator } from './model';

const LEGACY_EVENT_QUERY = {loadHistoricalContractManifest: true};

export async function getOverview(networkNodeUrls: string[], ethereumEndpoint: string): Promise<PosOverview> {
    let fullError = ''; 
    for(const url of networkNodeUrls) {
        try {
            const rawData = await fetchJson(url);
            return parseRawData(rawData.Payload, ethereumEndpoint);
        } catch (e) {
            fullError += `Warning: access to URL ${url} failed, trying another. Error: ${e}\n`;
        }
    }

    throw new Error(`Error while creating list of Guardians, all Network Node URL failed to respond. ${fullError}`);
}

export async function getAllDelegators(ethereumEndpoint: string) {
    const web3 = _.isString(ethereumEndpoint) ? await getWeb3(ethereumEndpoint) : ethereumEndpoint;
    const events = await readContractEvents(
        [Topics.Delegated],
        Contracts.Delegate,
        web3,
        getStartOfDelegationBlock().number,
        'latest',
        LEGACY_EVENT_QUERY
    );
    const chainId = await web3.eth.getChainId();

    const delegatorMap: {[key:string]: Delegator} = {};
    for (let event of events) {
        const delegatorAddress = new String(event.returnValues.from).toLowerCase();
        const delegator = {
            address: delegatorAddress,
            delegated_to: new String(event.returnValues.to).toLowerCase(),
            stake: 0,
            non_stake: 0,
            last_change_block: event.blockNumber,
            last_change_time: 0,
        }
        delegatorMap[delegatorAddress] = delegator;
    }

    const balanceMap = await readBalances(_.keys(delegatorMap), web3);
    const stakeMap = await readStakes(_.keys(delegatorMap), web3);
    _.forOwn(delegatorMap, (v) => {
        v.last_change_time = getBlockEstimatedTime(v.last_change_block, chainId);
        v.non_stake = balanceMap[v.address];
        v.stake = stakeMap[v.address];
    });

    return delegatorMap;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseRawData(data:any, ethereumEndpoint:string) : Promise<PosOverview> {
    const addrToName: {[key:string]: string} = {};
    _.forEach(data.Guardians, g => {
        addrToName[g.EthAddress] = g.Name;
    });

    const slices: PosOverviewSlice[] = [];
    _.forEach(data.CommitteeEvents, event => {
        const committee: PosOverviewData[] = [];
        let total_effective = 0;
        let total_weight = 0;

        _.forEach(event.Committee, member => {
            const effectiveStake = Number(member?.EffectiveStake || 0);
            const weight = Number(member?.Weight || 0);
            total_effective += effectiveStake;
            total_weight += weight
            committee.push(
            {
                name: addrToName[member.EthAddress],
                address: '0x' + String(member.EthAddress).toLowerCase(),
                effective_stake: effectiveStake,
                weight: weight,
            });
        });
        committee.sort((n1:any, n2:any) => n2.effectiveStake - n1.effectiveStake); // desc

        slices.push({
            block_number: event.RefBlock || 0,
            block_time: event.RefTime,
            total_effective_stake: total_effective,
            total_weight: total_weight,
            data: committee
        })
    });
    slices.sort((n1:any, n2:any) => n2.block_time - n1.block_time); // desc

    const web3 = _.isString(ethereumEndpoint) ? await getWeb3(ethereumEndpoint) : ethereumEndpoint;
    const {block, totalStake} = await readOverviewDataFromState(web3);
    const apy = 4000;
    
    return {
        block_number: block.number,
        block_time: Number(block.time),
        total_stake: totalStake,
        n_guardians: _.size(data?.Guardians) || 0,
        n_committee: data?.CurrentCommittee.length || 0,
        n_candidates: data?.CurrentCandidates.length || 0,
        apy,
        slices
    }
}
