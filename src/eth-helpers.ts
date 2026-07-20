/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import _ from 'lodash';
import Web3 from 'web3';
import BigNumber from 'bignumber.js';
// @ts-ignore
import { aggregate } from '@makerdao/multicall';
import { erc20Abi } from './abis/erc20';
import { erc20PolygonAbi } from './abis/erc20-polygon';
import { stakeAbi } from './abis/stake';
import { delegationAbi } from './abis/delegation';
import { guardianAbi } from './abis/guardian';
import { rewardsAbi } from './abis/rewards';
import { feeBootstrapRewardAbi } from './abis/feebootstrap';
import { bigToNumber, DECIMALS, getIpFromHex } from './helpers';
import { registryAbi } from './abis/registry';
import { deduplicateEvents, EventQueryOptions, readEventRange } from './query/event-reader';

export enum Topics {
    Staked = '0x1449c6dd7851abc30abf37f57715f492010519147cc2652fbc38202c18a6ee90',
    Restaked = '0xa217c421e0e9357b7b1815d752952b142ddc0e23f9f14ecb8233f8f83d563c4d',
    Unstaked = '0x7fc4727e062e336010f2c282598ef5f14facb3de68cf8195c2f23e1454b2b74e',
    Withdrew = '0xadec52fcd1408589179b85e44b434374db078b4eaf793e7d1a1bb0ae4ecfeee5',

    Delegated = '0x4bc154dd35d6a5cb9206482ecb473cdbf2473006d6bce728b9cc0741bcc59ea2',
    DelegateStakeChanged = '0x52db726bc1b1643b24886ed6f0194a41de9abac79d1c12108aca494e5b2bda6b',

    StakingRewardAllocated = '0x5830b366dc4564bf14d32116f14c979ac2c150a96b7c6b99bea717e6990d56ba',
    DelegatorRewardAssigned = '0x411edbca4a882d6fbf12b557451a9358a63f73e3011a8c712885cb1e207120dd',
    GuardianRewardAssigned = '0x3880098574881d40bf7b9775086fdc9e6d6edac939d881add769581473c84b45',
    StakingRewardsClaimed = '0x5f51e0cd4567b63928e199868f571929625ded3459b724759a0eb8edbf94158b',

    BootstrapRewardAssigned = '0x0964bebae9e6862697e967a3fe1c7ba8a0f52ba9b6d2cd754a41e8c3be7f8d66',
    FeeAssigned = '0x40ed9423e22a17617adb53819ad0279d3d22356c958e384e233214c870561b99',
    BootstrapWithdrawn = '0x565f40e50eac33ad36895230f693465a27f5341f25e6525568ae66cb24eb1a15',
    FeeWithdrawn = '0xdeb5099d7943aa2b4c1142e5d53d2f7636aa8f7bd130ec79816f151572bcdf45',

    GuardianRegisterd = '0xc2d72ac93e7fb29c534663a530cd3db012d5c336965e423e0ed5ee7a64ed8745',
    GuardianUpdateData = '0xedbe727a71a63bf990149415e72abb211f748254e2c40d878fdc02f440233d22',
    GuardianUpdateMetaData = '0x1cf3d48eb5d849f59c9ee28edc1564cde8ca0e708ccaecf5416a48d3810c5657',
}

export enum Contracts {
    Erc20 = 'Erc20',
    Stake = 'Stake',
    Delegate = 'delegations',
    Reward = 'stakingRewards',
    FeeBootstrapReward = 'feesAndBootstrapRewards',
    Guardian = 'guardiansRegistration',
    Registry = 'ContractRegistry'
}

export interface ContractValidData {
    address: string;
    startBlock: number;
    endBlock: number | string;
    abi: any;
}

export interface ContractsData {[key:string]: ContractValidData[]};

const maxPace = 4000000;

export async function getWeb3(ethereumEndpoint: string, readContracts:boolean = true) {
   const web3 = new Web3(new Web3.providers.HttpProvider(ethereumEndpoint, {keepAlive: true,}));
    web3.eth.transactionBlockTimeout = 0; // to stop web3 from polling pending tx
    web3.eth.transactionPollingTimeout = 0; // to stop web3 from polling pending tx
    web3.eth.transactionConfirmationBlocks = 1; // to stop web3 from polling pending tx

    Object.assign(web3, {'multicallContractAddress': '0xeefBa1e63905eF1D7ACbA5a8513c70307C1cE441'});
    const contractsData: ContractsData = {};
    contractsData[Contracts.Delegate] = [];
    contractsData[Contracts.Reward] = [];
    contractsData[Contracts.FeeBootstrapReward] = [];
    contractsData[Contracts.Guardian] = [];
    contractsData[Contracts.Erc20] = [{address: '0xff56Cc6b1E6dEd347aA0B7676C85AB0B3D08B0FA', startBlock: 5710114, endBlock: 'latest', abi: erc20Abi}];
    contractsData[Contracts.Stake] = [{address: '0x01D59Af68E2dcb44e04C50e05F62E7043F2656C3', startBlock: getStartOfPosBlock(1).number, endBlock: 'latest', abi: stakeAbi}];
    contractsData[Contracts.Registry] = [{address: '0xD859701C81119aB12A1e62AF6270aD2AE05c7AB3', startBlock: 11191400, endBlock: 'latest', abi: registryAbi /*getAbiByContractName(Contracts.Registry)*/ }];
    
    if (readContracts) {
        await readCurrentContractsAddresses(contractsData, web3, 1);
        Object.assign(web3, {contractsData});
    }

    return web3;
}

export async function getWeb3Polygon(ethereumEndpoint: string, readContracts:boolean = true) {
    const web3 = new Web3(new Web3.providers.HttpProvider(ethereumEndpoint, {keepAlive: true,}));
    web3.eth.transactionBlockTimeout = 0; // to stop web3 from polling pending tx
    web3.eth.transactionPollingTimeout = 0; // to stop web3 from polling pending tx
    web3.eth.transactionConfirmationBlocks = 1; // to stop web3 from polling pending tx

    Object.assign(web3, {'multicallContractAddress': '0x11ce4B23bD875D7F5C6a31084f55fDe1e9A87507'});
    const contractsData: ContractsData = {};
    contractsData[Contracts.Delegate] = [];
    contractsData[Contracts.Reward] = [];
    contractsData[Contracts.FeeBootstrapReward] = [];
    contractsData[Contracts.Guardian] = [];
    contractsData[Contracts.Erc20] = [{address: '0x614389EaAE0A6821DC49062D56BDA3d9d45Fa2ff', startBlock: 14283390, endBlock: 'latest', abi: erc20PolygonAbi}];
    contractsData[Contracts.Stake] = [{address: '0xeeae6791f684117b7028b48cb5dd21186df80b9c', startBlock: 25487295, endBlock: 'latest', abi: stakeAbi}];
    contractsData[Contracts.Registry] = [{address: '0x35eA0D75b2a3aB06393749B4651DfAD1Ffd49A77', startBlock: 25502848, endBlock: 'latest', abi: registryAbi /*getAbiByContractName(Contracts.Registry)*/ }];

    if (readContracts) {
        await readCurrentContractsAddresses(contractsData, web3, 137);
        Object.assign(web3, {contractsData});
    }

    return web3;
}

const MAX_CURRENT_REGISTRY_HOPS = 16;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const HISTORICAL_CONTRACT_TYPES = [
    Contracts.Delegate,
    Contracts.Reward,
    Contracts.FeeBootstrapReward,
    Contracts.Guardian
];

interface HistoricalContractManifestState {
    seed: ContractValidData;
    loaded: boolean;
    promise?: Promise<void>;
}

function copyContractData(contract: ContractValidData): ContractValidData {
    return {
        address: contract.address,
        startBlock: contract.startBlock,
        endBlock: contract.endBlock,
        abi: contract.abi
    };
}

function historicalManifestState(web3: any, seed?: ContractValidData): HistoricalContractManifestState {
    if (!web3.__posAnalyticsHistoricalContractManifest) {
        if (!seed) throw new Error('Missing initial ContractRegistry seed for historical manifest');
        web3.__posAnalyticsHistoricalContractManifest = {
            seed: copyContractData(seed),
            loaded: false
        } as HistoricalContractManifestState;
    }
    return web3.__posAnalyticsHistoricalContractManifest;
}

function normalizedContractAddress(address: any, description: string): string {
    const normalized = String(address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(normalized) || normalized === ZERO_ADDRESS) {
        throw new Error(`Invalid ${description} address: ${String(address)}`);
    }
    return normalized;
}

/**
 * Resolve only the contracts used for current state reads. Registry migrations
 * are followed with eth_call; startup deliberately performs no eth_getLogs.
 */
export async function readCurrentContractsAddresses(
    contractsData: ContractsData,
    web3: any,
    chainId: number,
    maxRegistryHops: number = MAX_CURRENT_REGISTRY_HOPS
): Promise<ContractsData> {
    const initialRegistry = contractsData[Contracts.Registry] && contractsData[Contracts.Registry][0];
    if (!initialRegistry) throw new Error('Missing initial ContractRegistry configuration');
    historicalManifestState(web3, initialRegistry);
    const boundedHops = Math.max(1, Math.floor(maxRegistryHops));
    let registryAddress = normalizedContractAddress(initialRegistry.address, 'registry');
    let delegateAddress = '';
    const visited: {[address: string]: boolean} = Object.create(null);

    for (let hop = 0; hop < boundedHops; hop += 1) {
        if (visited[registryAddress]) {
            throw new Error(`ContractRegistry migration loop detected at ${registryAddress}`);
        }
        visited[registryAddress] = true;
        const registry = new web3.eth.Contract(registryAbi, registryAddress);
        delegateAddress = normalizedContractAddress(
            await registry.methods.getContract(Contracts.Delegate).call(),
            Contracts.Delegate
        );
        const delegation = new web3.eth.Contract(delegationAbi, delegateAddress);
        const delegationRegistry = normalizedContractAddress(
            await delegation.methods.getContractRegistry().call(),
            'delegation registry'
        );
        if (delegationRegistry === registryAddress) break;
        registryAddress = delegationRegistry;
        delegateAddress = '';
    }

    if (!delegateAddress) {
        throw new Error(`Unable to resolve current ContractRegistry within ${boundedHops} hops`);
    }

    const currentRegistry = new web3.eth.Contract(registryAbi, registryAddress);
    const currentAddresses = await Promise.all([
        Promise.resolve(delegateAddress),
        currentRegistry.methods.getContract(Contracts.Reward).call(),
        currentRegistry.methods.getContract(Contracts.FeeBootstrapReward).call(),
        currentRegistry.methods.getContract(Contracts.Guardian).call()
    ]);
    const currentTypes = [Contracts.Delegate, Contracts.Reward, Contracts.FeeBootstrapReward, Contracts.Guardian];
    const startBlock = getStartOfPosBlock(chainId).number;
    currentTypes.forEach((contractType, index) => {
        const address = normalizedContractAddress(currentAddresses[index], contractType);
        contractsData[contractType] = [{
            address,
            startBlock,
            endBlock: 'latest',
            abi: getAbiForContract(address, contractType)
        }];
    });
    contractsData[Contracts.Registry] = [{
        address: registryAddress,
        startBlock,
        endBlock: 'latest',
        abi: registryAbi
    }];
    return contractsData;
}

/**
 * Legacy compatibility loader. The expensive Registry event replay is opt-in,
 * shared by concurrent callers and committed atomically only after success.
 */
export async function ensureHistoricalContracts(
    web3: any,
    queryOptions: EventQueryOptions = {}
): Promise<void> {
    const currentData: ContractsData = web3 && web3.contractsData;
    if (!currentData) throw new Error('Web3 contractsData is not initialized');
    const currentRegistry = currentData[Contracts.Registry] && currentData[Contracts.Registry][0];
    const state = historicalManifestState(web3, currentRegistry);
    if (state.loaded) return;
    if (state.promise) return state.promise;

    const loadOptions = Object.assign({}, queryOptions, {loadHistoricalContractManifest: false});
    const operation = (async () => {
        const historicalData: ContractsData = {};
        historicalData[Contracts.Erc20] = (currentData[Contracts.Erc20] || []).map(copyContractData);
        historicalData[Contracts.Stake] = (currentData[Contracts.Stake] || []).map(copyContractData);
        historicalData[Contracts.Registry] = [copyContractData(state.seed)];
        for (const contractType of HISTORICAL_CONTRACT_TYPES) historicalData[contractType] = [];

        await readContractsAddresses(historicalData, web3, loadOptions);
        for (const contractType of HISTORICAL_CONTRACT_TYPES) {
            const historical = historicalData[contractType];
            const current = currentData[contractType] && currentData[contractType][currentData[contractType].length - 1];
            if (!current || historical.length === 0) {
                throw new Error(`Historical Registry manifest is missing ${contractType}`);
            }
            const resolvedCurrent = historical[historical.length - 1];
            if (resolvedCurrent.address.toLowerCase() !== current.address.toLowerCase()) {
                throw new Error(`Historical Registry manifest current ${contractType} address does not match current state`);
            }
            resolvedCurrent.endBlock = 'latest';
        }
        for (const contractType of HISTORICAL_CONTRACT_TYPES) {
            currentData[contractType] = historicalData[contractType];
        }
    })();
    state.promise = operation.then(() => {
        state.loaded = true;
        state.promise = undefined;
    }, error => {
        state.promise = undefined;
        throw error;
    });
    return state.promise;
}

async function readContractsAddresses(
    contractsData: ContractsData,
    web3: any,
    queryOptions?: EventQueryOptions
) {
    let currentStartBlock = contractsData[Contracts.Registry][0].startBlock;
    let currentRegAddress = contractsData[Contracts.Registry][0].address;
    const visited: {[address: string]: boolean} = Object.create(null);

    for (let hop = 0; hop < MAX_CURRENT_REGISTRY_HOPS && currentRegAddress !== ''; hop += 1) {
        const normalizedRegistry = normalizedContractAddress(currentRegAddress, 'historical registry');
        if (visited[normalizedRegistry]) throw new Error(`Historical ContractRegistry migration loop detected at ${normalizedRegistry}`);
        visited[normalizedRegistry] = true;
        const currentRegContract = new web3.eth.Contract(contractsData[Contracts.Registry][0].abi, currentRegAddress);
        const res = await readRegisteryEvents(contractsData, currentRegContract, currentStartBlock, web3, queryOptions);
        currentRegAddress = res.nextRegContract;
        currentStartBlock = res.nextRegStartBlock;
        // we don't update the registry as this is one time use only (at the moment)
    }
    if (currentRegAddress !== '') {
        throw new Error(`Unable to load historical ContractRegistry manifest within ${MAX_CURRENT_REGISTRY_HOPS} hops`);
    }
    return contractsData;
}

export interface BlockInfo {
    time: number;
    number: number;
}
  
export async function getCurrentBlockInfo(web3:Web3): Promise<BlockInfo> {
    const block = await web3.eth.getBlock('latest'); 
    return {time: Number(block.timestamp)-13, number: block.number-1 } // one block back to avoid provider jitter
}

const refBlocksMap: {[chainId: number]: {time: number, number: number}} = {
    1: {time: 1603200055, number: 11093232 },
    137: {time: 1620563553, number: 14283390 }
}

export function getBlockEstimatedTime(blockNumber: number, chainId: number = 1, refBlocks? : {[chainId: number]: {time: number, number: number}}) {
    const refBlock = refBlocks? refBlocks[chainId] : refBlocksMap[chainId];
    const blockInfo = getStartOfPosBlock(chainId);
    const avgBlockTime = (refBlock.time - blockInfo.time) / (refBlock.number - blockInfo.number);
    return blockInfo.time + Math.round((blockNumber - blockInfo.number) * avgBlockTime);
}

export function getStartOfPosBlock(chainId: number = 1): BlockInfo {
    const blocksMap: {[chainId: string]: {time: number, number: number}} = {
        1: {time: 1586328645, number: 9830000 },
        137: {time: 1646207643, number: 25487295 }
    }
    return blocksMap[chainId];
}

export async function getRefBlocks(web3Instances: Web3[]) {
    // creates a reference for estimating actions time
    let blocksMap: {[chainId: string]: {time: number, number: number}} = {}
    for (const web3 of web3Instances) {
        const chainId = await web3.eth.getChainId();
        const blockInfo = await web3.eth.getBlock("latest")
        blocksMap[chainId] = {"time": Number(blockInfo.timestamp), "number": blockInfo.number}
    }
    return blocksMap;
}

export function getQueryPosBlock(potentialStart: number, nowBlock: number): number {
    if(potentialStart === 0 || potentialStart === -1) return getStartOfPosBlock().number;
    return Math.max(getStartOfPosBlock().number, potentialStart < 0 ? nowBlock+potentialStart : potentialStart);
}

export function getStartOfRewardsBlock(): BlockInfo { // TODO: add support for Polygon
    return {number: 11191407, time: 1604459620 };
}

export function getQueryRewardsBlock(potentialStart: number, nowBlock: number): number {
    if(potentialStart === 0 || potentialStart === -1) return getStartOfRewardsBlock().number;
    return Math.max(getStartOfRewardsBlock().number, potentialStart < 0 ? nowBlock+potentialStart : potentialStart);
}

export function getStartOfDelegationBlock(): BlockInfo { // TODO: add support for Polygon
    return {number: 11191403, time: 1604459583 };
}

export function getQueryDelegationBlock(potentialStart: number, nowBlock: number): number {
    if(potentialStart === 0 || potentialStart === -1) return getStartOfDelegationBlock().number;
    return Math.max(getStartOfDelegationBlock().number, potentialStart < 0 ? nowBlock+potentialStart : potentialStart);
}

const CURRENT_BLOCK_TIMESTAMP = 'CURRENT_BLOCK_TIMESTAMP';
function multicallToBlockInfo(multiCallRes: any): BlockInfo {
    return {
        number: multiCallRes.results.blockNumber.toNumber(), 
        time: multiCallRes.results.transformed[CURRENT_BLOCK_TIMESTAMP].toNumber()
    };
}

// Function depends on version 0.11.0 of makderdao/multicall only on 'latest' block
export async function readBalances(addresses:string[], web3:any) {
    const config = { web3, multicallAddress: web3.multicallContractAddress};
    const currentErc20Address = web3.contractsData[Contracts.Erc20][0].address;
    const calls: any[] = [];

    for (let address of addresses) {
        calls.push({
            target: currentErc20Address, 
            call: ['balanceOf(address)(uint256)', address],
            returns: [[address, (v: BigNumber.Value) => bigToNumber(new BigNumber(v))]]
        });
    }
    const r = await aggregate(calls, config);
    return r.results.transformed;
}

// Function depends on version 0.11.0 of makderdao/multicall only on 'latest' block
export async function readStakes(addresses:string[], web3:any) {
    const config = { web3, multicallAddress: web3.multicallContractAddress};
    const currentStakeAddress = web3.contractsData[Contracts.Stake][0].address;
    const calls: any[] = [];

    for (let address of addresses) {
        calls.push({
            target: currentStakeAddress, 
            call: ['getStakeBalanceOf(address)(uint256)', address],
            returns: [[address, (v: BigNumber.Value) => bigToNumber(new BigNumber(v))]]
        });
    }
    const r = await aggregate(calls, config);
    return r.results.transformed;
}

// Function depends on version 0.11.0 of makderdao/multicall only on 'latest' block
export async function readOverviewDataFromState(web3:any) {
    const config = { web3, multicallAddress: web3.multicallContractAddress};
    const delegateAddress = getLatestPosContractAddress(web3, Contracts.Delegate);
    const stakeAddress = getLatestPosContractAddress(web3, Contracts.Stake);
    const calls: any[] = [
        {
           target: delegateAddress, 
           call: ['uncappedDelegatedStake(address)(uint256)', '0xffffffffffffffffffffffffffffffffffffffff'],
           returns: [['uncapped', (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
             target: stakeAddress, 
             call: ['getTotalStakedTokens()(uint256)'],
             returns: [['staked', (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            call: ['getCurrentBlockTimestamp()(uint256)'],
            returns: [[CURRENT_BLOCK_TIMESTAMP]]
        },
    ];

    const r = await aggregate(calls, config);
    return { block: multicallToBlockInfo(r),
             totalStake: bigToNumber(r.results.transformed['staked'].minus(r.results.transformed['uncapped']))};
}

const balance = 'b', staked = 's', cooldownStake = 'cooldownStake', cooldownTime = 'cooldownTime';
const dRewardBalance = 'dRewardBalance', dRewardClaim = 'dRewardClaim', dGuardian = 'dGuardian', dRPT = 'dRPT', dDeltaRPT = 'dDeltaRPT';

/**
 * Minimal Delegator state for the visible Stake screen. This deliberately
 * excludes every reward-state call and performs a single multicall RPC.
 */
export async function readDelegatorCurrentDataFromState(address:string, web3:any) {
    const config = {web3, multicallAddress: web3.multicallContractAddress};
    const erc20Address = getLatestPosContractAddress(web3, Contracts.Erc20);
    const stakeAddress = getLatestPosContractAddress(web3, Contracts.Stake);
    const delegateAddress = getLatestPosContractAddress(web3, Contracts.Delegate);
    const calls: any[] = [
        {
            target: erc20Address,
            call: ['balanceOf(address)(uint256)', address],
            returns: [[balance, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress,
            call: ['getStakeBalanceOf(address)(uint256)', address],
            returns: [[staked, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress,
            call: ['getUnstakeStatus(address)(uint256,uint256)', address],
            returns: [
                [cooldownStake, (v: BigNumber.Value) => new BigNumber(v)],
                [cooldownTime, (v: BigNumber.Value) => new BigNumber(v)]
            ]
        },
        {
            target: delegateAddress,
            call: ['getDelegation(address)(address)', address],
            returns: [[dGuardian, (v: string) => v.toLowerCase()]]
        },
        {
            call: ['getCurrentBlockTimestamp()(uint256)'],
            returns: [[CURRENT_BLOCK_TIMESTAMP]]
        }
    ];
    const result = await aggregate(calls, config);
    const data = result.results.transformed;
    return {
        block: multicallToBlockInfo(result),
        non_stake: data[balance],
        staked: data[staked],
        cooldown_stake: data[cooldownStake],
        current_cooldown_time: data[cooldownTime].toNumber(),
        guardian: data[dGuardian]
    };
}

// Function depends on version 0.11.0 of makderdao/multicall only on 'latest' block
async function readDelegatorState(address:string, web3:any) {
    const config = { web3, multicallAddress: web3.multicallContractAddress};
    const erc20Address = getLatestPosContractAddress(web3, Contracts.Erc20);
    const stakeAddress = getLatestPosContractAddress(web3, Contracts.Stake);
    const rewardAddress = getLatestPosContractAddress(web3, Contracts.Reward);
    
    const calls: any[] = [
        {
           target: erc20Address, 
           call: ['balanceOf(address)(uint256)', address],
           returns: [[balance, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
             target: stakeAddress, 
             call: ['getStakeBalanceOf(address)(uint256)', address],
             returns: [[staked, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress, 
            call: ['getUnstakeStatus(address)(uint256,uint256)', address],
            returns: [
                [cooldownStake, (v: BigNumber.Value) => new BigNumber(v)],
                [cooldownTime, (v: BigNumber.Value) => new BigNumber(v)]
            ]
        },        
        {
            target: rewardAddress, 
            call: ['getDelegatorStakingRewardsData(address)(uint256,uint256,address,uint256,uint256)', address],
            returns: [
                [dRewardBalance, (v: BigNumber.Value) => new BigNumber(v)],
                [dRewardClaim, (v: BigNumber.Value) => new BigNumber(v)],
                [dGuardian, (v: string) => v.toLowerCase()],
                [dRPT, (v: BigNumber.Value) => new BigNumber(v)],
                [dDeltaRPT, (v: BigNumber.Value) => new BigNumber(v)]
               ]
        },
        {
            call: ['getCurrentBlockTimestamp()(uint256)'],
            returns: [[CURRENT_BLOCK_TIMESTAMP]]
        }
    ];

    const r = await aggregate(calls, config);
    return { block: multicallToBlockInfo(r), data: r.results.transformed};
}

export async function readDelegatorDataFromState(address:string, web3:any) {
    const {block, data} = await readDelegatorState(address, web3);
    const guardianRes = await getLatestPosContract(web3, Contracts.Reward).methods.getGuardianStakingRewardsData(data[dGuardian]).call({}, block.number);
    return {
        block,
        non_stake: data[balance],
        staked: data[staked],
        cooldown_stake: data[cooldownStake],
        current_cooldown_time: data[cooldownTime].toNumber(),
        self_reward_balance: data[dRewardBalance],
        self_reward_claimed: data[dRewardClaim],
        self_total_rewards: data[dRewardBalance].plus(data[dRewardClaim]),
        self_last_rewarded: data[staked].multipliedBy(data[dDeltaRPT]).dividedBy(DECIMALS),
        delegator_RPT: data[dRPT],
        delegator_delta_RPT: data[dDeltaRPT],
        guardian: data[dGuardian],
        guardian_delta_RPW: new BigNumber(guardianRes.stakingRewardsPerWeightDelta),
        guardian_RPW: new BigNumber(guardianRes.lastStakingRewardsPerWeight),
        guardian_delta_RPT: new BigNumber(guardianRes.delegatorRewardsPerTokenDelta),
        guardian_RPT: new BigNumber(guardianRes.delegatorRewardsPerToken),
    };
}

const gIp = 'ip', gName = 'name', gWebsite = 'website', gOrbsAddr = 'orbsaddress', gRegTime = 'gRegTime', gUpdateTime = 'gUpdateTime', gUrl = 'gUrl', gDelegateStake = 'gDelegateStake';
const gRewardBalance = 'gRewardBalance', gRewardClaim = 'gRewardClaim', gLastRewardBalance = 'gLastRewardBalance', gLastRewardClaim = 'gLastRewardClaim', gRPW = 'gRPW', gDeltaRPW = 'gDeltaRPW', gRPT = 'gRPT', gDeltaRPT = 'gDeltaRPT', gRewardPrecent = 'gRewardPrecent';
const gFeeBalance = 'gFeeBalance', gFeeWithdraw = 'gFeeWithdraw', gBootBalance = 'gBootBalance', gBootWithdraw = 'gBootWithdraw', gCertified = 'gCertified';

/**
 * Minimal Guardian state for the visible header and Stake screen. Reward
 * balances, fees, bootstrap rewards and hidden action data are not queried.
 */
export async function readGuardianCurrentDataFromState(address:string, web3:any) {
    const config = {web3, multicallAddress: web3.multicallContractAddress};
    const erc20Address = getLatestPosContractAddress(web3, Contracts.Erc20);
    const stakeAddress = getLatestPosContractAddress(web3, Contracts.Stake);
    const rewardAddress = getLatestPosContractAddress(web3, Contracts.Reward);
    const guardianContractAddress = getLatestPosContractAddress(web3, Contracts.Guardian);
    const delegateAddress = getLatestPosContractAddress(web3, Contracts.Delegate);
    const calls: any[] = [
        {
            target: erc20Address,
            call: ['balanceOf(address)(uint256)', address],
            returns: [[balance, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress,
            call: ['getStakeBalanceOf(address)(uint256)', address],
            returns: [[staked, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress,
            call: ['getUnstakeStatus(address)(uint256,uint256)', address],
            returns: [
                [cooldownStake, (v: BigNumber.Value) => new BigNumber(v)],
                [cooldownTime, (v: BigNumber.Value) => new BigNumber(v)]
            ]
        },
        {
            target: rewardAddress,
            call: ['getGuardianDelegatorsStakingRewardsPercentMille(address)(uint256)', address],
            returns: [[gRewardPrecent, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: delegateAddress,
            call: ['getDelegatedStake(address)(uint256)', address],
            returns: [[gDelegateStake, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: guardianContractAddress,
            call: ['getMetadata(address,string)(string)', address, 'ID_FORM_URL'],
            returns: [[gUrl]]
        },
        {
            target: guardianContractAddress,
            call: ['getGuardianData(address)(bytes4,address,string,string,uint,uint)', address],
            returns: [
                [gIp, (v: string) => getIpFromHex(v)],
                [gOrbsAddr, (v: string) => v.toLowerCase()],
                [gName], [gWebsite],
                [gRegTime, (v: BigNumber.Value) => new BigNumber(v)],
                [gUpdateTime, (v: BigNumber.Value) => new BigNumber(v)]
            ]
        },
        {
            call: ['getCurrentBlockTimestamp()(uint256)'],
            returns: [[CURRENT_BLOCK_TIMESTAMP]]
        }
    ];
    const result = await aggregate(calls, config);
    const data = result.results.transformed;
    return {
        block: multicallToBlockInfo(result),
        details: {
            name: data[gName],
            website: data[gWebsite],
            ip: data[gIp],
            node_address: data[gOrbsAddr],
            registration_time: data[gRegTime].toNumber(),
            last_update_time: data[gUpdateTime].toNumber(),
            details_URL: data[gUrl]
        },
        stake_status: {
            self_stake: bigToNumber(data[staked]),
            cooldown_stake: bigToNumber(data[cooldownStake]),
            current_cooldown_time: data[cooldownTime].toNumber(),
            non_stake: bigToNumber(data[balance]),
            delegated_stake: bigToNumber(data[gDelegateStake].minus(data[staked])),
            total_stake: bigToNumber(data[gDelegateStake])
        },
        reward_status: {
            delegator_reward_share: data[gRewardPrecent].toNumber() / 100000
        }
    };
}

// Function depends on version 0.11.0 of makderdao/multicall only on 'latest' block
async function readGuardianState(address:string, web3:any) {
    const config = { web3, multicallAddress: web3.multicallContractAddress};
    const erc20Address = getLatestPosContractAddress(web3, Contracts.Erc20);
    const stakeAddress = getLatestPosContractAddress(web3, Contracts.Stake);
    const rewardAddress = getLatestPosContractAddress(web3, Contracts.Reward);
    const guardianContracAddress = getLatestPosContractAddress(web3, Contracts.Guardian);
    const delegateAddress = getLatestPosContractAddress(web3, Contracts.Delegate);
    const feeBootstrapAddress = getLatestPosContractAddress(web3, Contracts.FeeBootstrapReward);
    
    const calls: any[] = [
        {
           target: erc20Address, 
           call: ['balanceOf(address)(uint256)', address],
           returns: [[balance, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress, 
            call: ['getStakeBalanceOf(address)(uint256)', address],
            returns: [[staked, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: stakeAddress, 
            call: ['getUnstakeStatus(address)(uint256,uint256)', address],
            returns: [
                [cooldownStake, (v: BigNumber.Value) => new BigNumber(v)],
                [cooldownTime, (v: BigNumber.Value) => new BigNumber(v)]
            ]
        },        
        {
            target: rewardAddress, 
            call: ['getDelegatorStakingRewardsData(address)(uint256,uint256,address,uint256,uint256)', address],
            returns: [
                [dRewardBalance, (v: BigNumber.Value) => new BigNumber(v)],
                [dRewardClaim, (v: BigNumber.Value) => new BigNumber(v)],
                [dGuardian, (v: string) => v.toLowerCase()],
                [dRPT, (v: BigNumber.Value) => new BigNumber(v)],
                [dDeltaRPT, (v: BigNumber.Value) => new BigNumber(v)]
               ]
        },
        {
            target: rewardAddress, 
            call: ['getGuardianStakingRewardsData(address)(uint256,uint256,uint256,uint256,uint256,uint256)', address],
            returns: [
                [gRewardBalance, (v: BigNumber.Value) => new BigNumber(v)],
                [gRewardClaim, (v: BigNumber.Value) => new BigNumber(v)],
                [gRPT, (v: BigNumber.Value) => new BigNumber(v)],
                [gDeltaRPT, (v: BigNumber.Value) => new BigNumber(v)],
                [gRPW, (v: BigNumber.Value) => new BigNumber(v)],
                [gDeltaRPW, (v: BigNumber.Value) => new BigNumber(v)]
               ]
        },
        {
            target: rewardAddress, 
            call: ['getGuardianDelegatorsStakingRewardsPercentMille(address)(uint256)', address],
            returns: [[gRewardPrecent, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: rewardAddress, 
            call: ['guardiansStakingRewards(address)(uint96,uint96,uint96,uint96)', address],
            returns: [[],[],
               [gLastRewardBalance, (v: BigNumber.Value) => new BigNumber(v)],
               [gLastRewardClaim, (v: BigNumber.Value) => new BigNumber(v)]
        ]
        },
        {
            target: delegateAddress, 
            call: ['getDelegatedStake(address)(uint256)', address],
            returns: [[gDelegateStake, (v: BigNumber.Value) => new BigNumber(v)]]
        },
        {
            target: feeBootstrapAddress, 
            call: ['getFeesAndBootstrapData(address)(uint256,uint256,uint256,uint256,uint256,uint256,bool)', address],
            returns: [
                [gFeeBalance, (v: BigNumber.Value) => new BigNumber(v)],
                [],
                [gBootBalance, (v: BigNumber.Value) => new BigNumber(v)],
                [],
                [gFeeWithdraw, (v: BigNumber.Value) => new BigNumber(v)],
                [gBootWithdraw, (v: BigNumber.Value) => new BigNumber(v)],
                [gCertified]
               ]
        },
        {
            target: guardianContracAddress, 
            call: ['getMetadata(address,string)(string)', address, 'ID_FORM_URL'],
            returns: [[gUrl]]
        },
        {
            target: guardianContracAddress, 
            call: ['getGuardianData(address)(bytes4,address,string,string,uint,uint)', address],
            returns: [
                [gIp, (v: string) => getIpFromHex(v)],
                [gOrbsAddr, (v: string) => v.toLowerCase()],
                [gName], [gWebsite], 
                [gRegTime, (v: BigNumber.Value) => new BigNumber(v)],
                [gUpdateTime, (v: BigNumber.Value) => new BigNumber(v)]
               ]
        },
        {
            call: ['getCurrentBlockTimestamp()(uint256)'],
            returns: [[CURRENT_BLOCK_TIMESTAMP]]
        }
    ];

    const r = await aggregate(calls, config);
    return { block: multicallToBlockInfo(r), data: r.results.transformed};
}

export async function readGuardianDataFromState(address:string, web3:any) {
    const {block, data} = await readGuardianState(address, web3);
    return  {
        block,
        details: {
            name: data[gName],
            website: data[gWebsite],
            ip: data[gIp],
            node_address: data[gOrbsAddr],
            registration_time: data[gRegTime].toNumber(),
            last_update_time: data[gUpdateTime].toNumber(),
            details_URL: data[gUrl],
            certified: data[gCertified]
        },
        stake_status: {
            self_stake: bigToNumber(data[staked]),
            cooldown_stake: bigToNumber(data[cooldownStake]),
            current_cooldown_time: data[cooldownTime].toNumber(),
            non_stake: bigToNumber(data[balance]),
            delegated_stake: bigToNumber(data[gDelegateStake].minus(data[staked])),
            total_stake: bigToNumber(data[gDelegateStake]),
        },
        reward_status: {
            guardian_rewards_balance: bigToNumber(data[gRewardBalance]), 
            guardian_rewards_claimed: bigToNumber(data[gRewardClaim]),
            total_guardian_rewards: bigToNumber(data[gRewardBalance].plus(data[gRewardClaim])),
            delegator_rewards_balance: bigToNumber(data[dRewardBalance]), 
            delegator_rewards_claimed: bigToNumber(data[dRewardClaim]),
            total_delegator_rewards: bigToNumber(data[dRewardBalance].plus(data[dRewardClaim])),
            fees_balance: bigToNumber(data[gFeeBalance]), 
            fees_claimed: bigToNumber(data[gFeeWithdraw]),
            total_fees: bigToNumber(data[gFeeBalance].plus(data[gFeeWithdraw])),
            bootstrap_balance: bigToNumber(data[gBootBalance]), 
            bootstrap_claimed: bigToNumber(data[gBootWithdraw]),
            total_bootstrap: bigToNumber(data[gBootBalance].plus(data[gBootWithdraw])),
            delegator_reward_share: data[gRewardPrecent].toNumber() / 100000     
        }, 
        
        total_rewards: data[gRewardBalance].plus(data[gRewardClaim]),
        last_rewarded: data[gRewardBalance].plus(data[gRewardClaim]).minus(data[gLastRewardBalance]).minus(data[gLastRewardClaim]),
        self_total_rewards: data[dRewardBalance].plus(data[dRewardClaim]),
        self_last_rewarded: data[staked].multipliedBy(data[dDeltaRPT]).dividedBy(DECIMALS),
        guardian: address.toLowerCase(),
        guardian_delta_RPW: data[gDeltaRPW],
        guardian_RPW: data[gRPW],
        guardian_delta_RPT: data[gDeltaRPT],
        guardian_RPT: data[gRPT],
        delegator_delta_RPT: data[dDeltaRPT],
        delegator_RPT: data[dRPT],
    };
}

export function addressToTopic(address:string) {
    return '0x000000000000000000000000' + address.substr(2).toLowerCase();
}

export function appendItems<T>(target: T[], items: T[]) {
    for (const item of items) {
        target.push(item);
    }
}

function configuredEventQueryOptions(web3: any, overrides?: EventQueryOptions): EventQueryOptions {
    return Object.assign({}, web3 && web3.eventQueryOptions ? web3.eventQueryOptions : {}, overrides || {});
}

interface CachedEventCoverage {
    fromBlock: number;
    toBlock: number;
}

interface EventRangeCacheEntry {
    coverage: CachedEventCoverage[];
    events: any[];
    mutable?: {
        fromBlock: number;
        toBlock: number;
        events: any[];
        loadedAt: number;
    };
}

const DEFAULT_EVENT_CACHE_FINALITY: {[chainId: string]: number} = {
    1: 64,
    137: 256
};

function eventCacheHost(web3: any): {[key: string]: EventRangeCacheEntry} {
    if (!web3.__posAnalyticsEventRangeCache) {
        web3.__posAnalyticsEventRangeCache = Object.create(null);
    }
    return web3.__posAnalyticsEventRangeCache;
}

function eventCacheKey(contract: any, filter: (string[] | string | undefined)[]): string | undefined {
    const address = contract && contract.options && contract.options.address;
    if (!address) return undefined;
    return `${String(address).toLowerCase()}:${JSON.stringify(filter)}`;
}

function normalizeCoverage(ranges: CachedEventCoverage[]): CachedEventCoverage[] {
    const sorted = ranges.slice().sort((a, b) => a.fromBlock - b.fromBlock || a.toBlock - b.toBlock);
    const result: CachedEventCoverage[] = [];
    for (const range of sorted) {
        const previous = result[result.length - 1];
        if (!previous || range.fromBlock > previous.toBlock + 1) {
            result.push({fromBlock: range.fromBlock, toBlock: range.toBlock});
        } else {
            previous.toBlock = Math.max(previous.toBlock, range.toBlock);
        }
    }
    return result;
}

function missingCoverage(fromBlock: number, toBlock: number, coverage: CachedEventCoverage[]): CachedEventCoverage[] {
    if (fromBlock > toBlock) return [];
    const missing: CachedEventCoverage[] = [];
    let cursor = fromBlock;
    for (const range of normalizeCoverage(coverage)) {
        if (range.toBlock < cursor || range.fromBlock > toBlock) continue;
        if (range.fromBlock > cursor) {
            missing.push({fromBlock: cursor, toBlock: Math.min(toBlock, range.fromBlock - 1)});
        }
        cursor = Math.max(cursor, range.toBlock + 1);
        if (cursor > toBlock) break;
    }
    if (cursor <= toBlock) missing.push({fromBlock: cursor, toBlock});
    return missing;
}

function eventsWithin(events: any[], fromBlock: number, toBlock: number): any[] {
    return events.filter(event => {
        const block = Number(event && event.blockNumber);
        return isFinite(block) && block >= fromBlock && block <= toBlock;
    });
}

async function numericEndBlock(endBlock: number | string, web3: any): Promise<number> {
    if (typeof endBlock === 'number') return Math.floor(endBlock);
    if (endBlock !== 'latest') throw new Error(`Unsupported event query end block: ${endBlock}`);
    if (web3.eth.getBlockNumber) return Number(await web3.eth.getBlockNumber());
    const latest = await web3.eth.getBlock('latest');
    return Number(latest.number);
}

export async function readContractEvents(
    filter: (string[] | string | undefined)[],
    contractsType: Contracts,
    web3: Web3,
    fromBlock?: number,
    toBlock: number | string = 'latest',
    queryOptions?: EventQueryOptions
) {
    const effectiveOptions = configuredEventQueryOptions(web3, queryOptions);
    if (effectiveOptions.loadHistoricalContractManifest) {
        await ensureHistoricalContracts(web3, effectiveOptions);
    }
    if (!fromBlock) {
        const chainId = await web3.eth.getChainId();
        fromBlock = getStartOfPosBlock(chainId).number;
    }
    const requestedEnd = await numericEndBlock(toBlock, web3);
    const contractsData: ContractValidData[] = (web3 as any).contractsData[contractsType] || [];
    const allEvents: any[] = [];
    for (const contractData of contractsData) {
        const deploymentEnd = contractData.endBlock === 'latest' ? requestedEnd : Number(contractData.endBlock);
        if (!isFinite(deploymentEnd)) throw new Error(`Invalid contract end block: ${contractData.endBlock}`);
        const activeFrom = Math.max(fromBlock, contractData.startBlock);
        const activeTo = Math.min(requestedEnd, deploymentEnd);
        if (activeFrom > activeTo) continue;

        const contract = new (web3 as any).eth.Contract(contractData.abi, contractData.address);
        const events = await readEvents(filter, contract, web3, activeFrom, activeTo, maxPace, effectiveOptions);
        for (const event of events) {
            if (event && !event.address) {
                allEvents.push(Object.assign({}, event, {address: contractData.address}));
            } else {
                allEvents.push(event);
            }
        }
    }
    return deduplicateEvents(allEvents).events.sort(ascendingEvents);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readEvents(
    filter: (string[] | string | undefined)[],
    contract: any,
    web3: any,
    startBlock: number,
    endBlock: number | string,
    pace: number,
    queryOptions?: EventQueryOptions
) {
    const numericEnd = await numericEndBlock(endBlock, web3);
    const effectiveOptions = configuredEventQueryOptions(web3, queryOptions);
    if (effectiveOptions.initialChunkSize === undefined) effectiveOptions.initialChunkSize = pace;
    if (effectiveOptions.maxChunkSize === undefined) effectiveOptions.maxChunkSize = pace;
    const contractAddress = contract && contract.options ? contract.options.address : undefined;
    const baseCacheKey = eventCacheKey(contract, filter);
    if (effectiveOptions.cache === false || !baseCacheKey || startBlock > numericEnd) {
        const direct = await readEventRange({
            contract,
            topics: filter,
            fromBlock: startBlock,
            toBlock: numericEnd,
            contractAddress
        }, effectiveOptions);
        return direct.events;
    }

    const chainId = web3.eth.getChainId ? Number(await web3.eth.getChainId()) : 0;
    const configuredFinality = effectiveOptions.cacheFinalityBlocks;
    if (configuredFinality !== undefined && (!isFinite(configuredFinality) || configuredFinality < 0)) {
        throw new Error('cacheFinalityBlocks must be a non-negative finite number');
    }
    const finalityBlocks = configuredFinality === undefined
        ? DEFAULT_EVENT_CACHE_FINALITY[String(chainId)] || 0
        : Math.max(0, Math.floor(configuredFinality));
    const mutableCacheTtl = effectiveOptions.cacheMutableForMs === undefined
        ? 0
        : Number(effectiveOptions.cacheMutableForMs);
    if (!isFinite(mutableCacheTtl) || mutableCacheTtl < 0) {
        throw new Error('cacheMutableForMs must be a non-negative finite number');
    }
    const key = `${baseCacheKey}:finality:${finalityBlocks}`;
    const stableEnd = Math.max(startBlock - 1, numericEnd - finalityBlocks);
    const cache = eventCacheHost(web3);
    const entry = cache[key] || {coverage: [], events: []};
    cache[key] = entry;
    const collected = eventsWithin(entry.events, startBlock, stableEnd);

    for (const range of missingCoverage(startBlock, stableEnd, entry.coverage)) {
        const callerOnChunk = effectiveOptions.onChunk;
        const result = await readEventRange({
            contract,
            topics: filter,
            fromBlock: range.fromBlock,
            toBlock: range.toBlock,
            contractAddress
        }, Object.assign({}, effectiveOptions, {
            onChunk: (chunk: any) => {
                appendItems(entry.events, chunk.events);
                entry.events = deduplicateEvents(entry.events, contractAddress).events;
                entry.coverage = normalizeCoverage(entry.coverage.concat({
                    fromBlock: chunk.fromBlock,
                    toBlock: chunk.toBlock
                }));
                if (callerOnChunk) callerOnChunk(chunk);
            }
        }));
        appendItems(collected, result.events);
    }
    entry.events = deduplicateEvents(entry.events, contractAddress).events;

    const mutableFrom = Math.max(startBlock, stableEnd + 1);
    if (mutableFrom <= numericEnd) {
        const now = effectiveOptions.dependencies && effectiveOptions.dependencies.now
            ? effectiveOptions.dependencies.now()
            : Date.now();
        const cachedMutable = entry.mutable;
        const canReuseMutable = mutableCacheTtl > 0 &&
            !!cachedMutable &&
            cachedMutable.fromBlock <= mutableFrom &&
            cachedMutable.toBlock >= numericEnd &&
            now - cachedMutable.loadedAt >= 0 &&
            now - cachedMutable.loadedAt < mutableCacheTtl;
        if (canReuseMutable && cachedMutable) {
            appendItems(collected, eventsWithin(cachedMutable.events, mutableFrom, numericEnd));
        } else {
            const mutable = await readEventRange({
                contract,
                topics: filter,
                fromBlock: mutableFrom,
                toBlock: numericEnd,
                contractAddress
            }, effectiveOptions);
            appendItems(collected, mutable.events);
            if (mutableCacheTtl > 0) {
                entry.mutable = {
                    fromBlock: mutableFrom,
                    toBlock: numericEnd,
                    events: deduplicateEvents(mutable.events, contractAddress).events,
                    loadedAt: now
                };
            }
        }
    }
    return deduplicateEvents(collected, contractAddress).events.sort(ascendingEvents);
}

async function readRegisteryEvents(
    contractsData: ContractsData,
    regContract: any,
    startBlock: number,
    web3: any,
    queryOptions?: EventQueryOptions
) {
    const cacheHost = web3 as any;
    if (!cacheHost.__posAnalyticsRegistryEventCache) cacheHost.__posAnalyticsRegistryEventCache = Object.create(null);
    const address = regContract && regContract.options ? String(regContract.options.address).toLowerCase() : 'registry';
    const cacheKey = `${address}:${startBlock}`;
    let events = cacheHost.__posAnalyticsRegistryEventCache[cacheKey];
    if (!events) {
        events = await readEvents([], regContract, web3, startBlock, 'latest', maxPace, queryOptions);
        cacheHost.__posAnalyticsRegistryEventCache[cacheKey] = events.slice();
    } else {
        events = events.slice();
    }
    events.sort(ascendingEvents); 
    for (let event of events) {
        if (event.event === 'ContractAddressUpdated') {
            const contractName = event.returnValues.contractName;
            if (_.has(contractsData, contractName)) {
                const contractData = contractsData[contractName];
                if(contractData.length > 0) {
                    contractData[contractData.length-1].endBlock = event.blockNumber;
                }
                const address = String(event.returnValues.addr).toLowerCase();
                contractData.push({
                    address,
                    startBlock: event.blockNumber+1,
                    endBlock: 'latest',
                    abi: getAbiForContract(address, contractName)                
                });
            }
        } else if (event.event === 'ContractRegistryUpdated') {
            return { nextRegContract: String(event.returnValues.newContractRegistry).toLowerCase(), nextRegStartBlock: event.blockNumber };
        }
    }
    return {nextRegContract: '', nextRegStartBlock: 0};
}

function getLatestPosContractAddress(web3:any, contract: Contracts): string {
    return web3.contractsData[contract][web3.contractsData[contract].length-1].address;
}

// Note new Contract leaks this is code for client side only 
export function getLatestPosContract(web3:any, contract: Contracts) {
    const current = web3.contractsData[contract][web3.contractsData[contract].length-1];
    return new web3.eth.Contract(current.abi, current.address);
}

// Note new Contract leaks this is code for client side only 
export function getPosContracts(web3:any, contract: Contracts): any[] {
    const contracts = [];
    for (const data of web3.contractsData[contract]) {
        contracts.push(new web3.eth.Contract(data.abi, data.address));
    }
    return contracts
}

function getAbiForContract(address: string, contractName: any) {
    // TODO find way to use the fs in lib mode.
    // attempts to get the ABI by address first (useful for deprecated contracts and breaking ABI changes)
    // let abi = getAbiByContractAddress(address);
    // if (abi) return abi;
  
    // abi = getAbiByContractRegistryKey(contractName);
    // if (abi) return abi;

    // ugly fallback
    if (contractName == Contracts.Delegate) {
        return delegationAbi;
    } else if (contractName == Contracts.Reward) {
        return rewardsAbi;
    } else if (contractName == Contracts.FeeBootstrapReward) {
        return feeBootstrapRewardAbi;
    } else if (contractName == Contracts.Guardian) {
        return guardianAbi;
    }
    
    throw new Error(`failed to get abi for ${address} type ${contractName}`);
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ascendingEvents(e1:any, e2:any) {
    if (e1.blockNumber !== e2.blockNumber) {
        return e1.blockNumber - e2.blockNumber;
    } else if (e1.transactionIndex !== e2.transactionIndex) {
        return e1.transactionIndex - e2.transactionIndex
    }
    return e1.logIndex - e2.logIndex;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function descendingEvents(e1:any, e2:any) {
    if (e1.blockNumber !== e2.blockNumber) {
        return e2.blockNumber - e1.blockNumber;
    } else if (e1.transactionIndex !== e2.transactionIndex) {
        return e2.transactionIndex - e1.transactionIndex
    }
    return e2.logIndex - e1.logIndex;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function descendingBlockNumbers(e1:any, e2:any) {
    return e2.blockNumber - e1.blockNumber;
}

export function generateTxLink(txHash: string, chainId: number = 1): string {
    return chainId === 1 ? `https://etherscan.io/tx/${txHash}` : `https://polygonscan.com/tx/${txHash}`;
}
