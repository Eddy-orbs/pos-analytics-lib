# ORBS PoS analytics lib

Library to use to extract PoS data of the Orbs Network (for V2).

## Users

### Install
```
npm i @orbs-network/pos-analytics-lib
```

### Functions

* getDelegator

Used to query information about delegator's stake, previous actions and optional rewards.
Funciton's input is the requested delegator's address, an Ethereum endpoint (for example infura link with apikey) 
and optional options object to modify output (see below).

```
const delegatorInfo = await getDelegator(
  '0xB4D4f0E476Afe791B26B39985A65B1bC1BBAcdcA',
  ethereumEndpoint
);
```  
Or
```
const delegatorAndRewardsInfo = await getDelegator(
  '0xB4D4f0E476Afe791B26B39985A65B1bC1BBAcdcA',
  ethereumEndpoint, {read_from_block: -1000000}
);
```  

* getDelegatorStakingRewards

Used to query information about delegator's staking rewards history & claim action history.
Funciton's input is the requested delegator's address, an Ethereum endpoint (for example infura link with apikey) 
and optional options object to modify output (see below).

```
const { rewards, claimActions } = await getDelegatorStakingRewards(
  '0xB4D4f0E476Afe791B26B39985A65B1bC1BBAcdcA',
  ethereumEndpoint
);
```  

* getGuardians

Used to query the list of all current Guardians and their names and weights. Function's input is a list of ORBS node management status URLs.

```
const guardians = await getGuardians(nodeEndpoints);
```

* getGuardian

Used to query a guardian's staking and delegator history, list all current delegators and event history.
Function's input is the requested guardian's address, an Ethereum endpoint (for example infura link with apikey) 
and optional options object to modify output (see below).
<br>Please note: as long as history reading is not disabled all of the delegation history of the guardian is always read.

```
const guardianInfo = await getGuardian(
  '0xf7ae622c77d0580f02bcb2f92380d61e3f6e466c',
  ethereumEndpoint
);
```
Or 
```
const guardianAndRewardsInfo = await getGuardian(
  '0xf7ae622c77d0580f02bcb2f92380d61e3f6e466c',
  ethereumEndpoint, {read_from_block: -1000000, read_rewards_disable: true}
);
```

* getGuardianStakingRewards

Used to query information about guardian's staking rewards history (both as guardian and as self-delegator) & claim action history.
Funciton's input is the requested guardian's address, an Ethereum endpoint (for example infura link with apikey)
and optional options object to modify output (see below).

```
const { rewardsAsGuardian, rewardsAsDelegator, claimActions } = await getGuardianStakingRewards(
  '0xf7ae622c77d0580f02bcb2f92380d61e3f6e466c',
  ethereumEndpoint
);
```  

* getOverview

Used to get an overview of the ORBS network nodes (guardians) stakes and weight history. Function's input is a list of ORBS node management status URLs and an Ethereum endpoint.

```
const overview = await getOverview(nodeEndpoints, ethereumEndpoint);
```

* getAllDelegators

Used to get a map of all the delegators of the ORBS network (including guardians who are self-delegators)
with their current staked and non-staked balances and the last block that they changed their delegation. 
Function's input is an Ethereum endpoint.

```
const delegatorMap = await getAllDelegators(ethereumEndpoint);
```

### Load-aware detail APIs

New applications should compose detail screens from the smaller APIs below instead of calling the legacy
`getGuardian` / `getDelegator` aggregate functions on page entry.

* `getGuardianCurrent(address, web3)` and `getDelegatorCurrent(address, web3)` read current contract state only.
  They do not query event logs.
* `getGuardianStakeHistory` and `getDelegatorStakeHistory` use bounded archive state sampling when
  `sample_timestamps` is supplied. This issues no event-log query and reads only the chart's selected points.
  The range-scoped event reconstruction mode remains available when `sample_timestamps` is omitted.
* `resolveBlockAtOrAfterTimestamp(web3, unixTimestamp)` resolves a time-window boundary with a bounded block
  timestamp binary search.
* `getGuardianDelegatorsPage(address, web3, {page_size, cursor})` loads the delegator list only when requested.
  It seeds from a block-pinned Subgraph snapshot, replays only the short RPC delta, and hydrates balances only for
  the returned page. Ethereum uses materialized entities; Polygon adapts its legacy absolute-event schema.
  A full-chain RPC fallback is disabled unless `allow_full_rpc_fallback: true` is explicitly supplied.

Web3 initialization resolves current contracts through bounded registry `eth_call` hops and performs no registry
event scan. Legacy aggregate and event-reconstruction calls lazily rebuild the historical contract manifest from
Registry events once per Web3 instance; current-state, sampled-history and Guardian-page delta calls never trigger
that full Registry replay. Event-mode reads use an inclusive adaptive engine: provider range-limit errors split the block range,
HTTP 429 responses use pacing/backoff and ultimately split, transient failures are retried, and completed immutable
ranges are cached by finality policy. Sampled-state reads use paced archive `eth_call` with bounded retry and never
fall back to an unbounded log scan. Every history response includes `data_quality`; consumers must hide a metric
when its availability flag is false.

```ts
const current = await getGuardianCurrent(address, web3);
const fromBlock = await resolveBlockAtOrAfterTimestamp(web3, twelveMonthsAgo);
const history = await getGuardianStakeHistory(address, web3, {
  from_block: fromBlock,
  sample_timestamps: utcBucketBoundaries,
  current_snapshot: current,
  state_call_interval_ms: 350
});
const firstPage = await getGuardianDelegatorsPage(address, web3, {page_size: 50});
```

### Helper Functions

* delegatorToXlsx

Used to translate the output of `getDelegator` to xlsx format. Input is delegatorInfo object and output-type
which is one of "buffer" or "array" or "binary" or "string" or "base64" (depending what you want to do with the output).

```
const delegatorInfo = await getDelegator('0x1e9673315e0ada0db640c299ddd2a1d81d220180', ethereumEndpoint);
const delegatorXlsx = delegatorToXlsx(delegatorInfo, 'buffer');
fs.writeFileSync(path, delegatorXlsx);
```

* guardianToXlsx

Used to translate the output of `getGuardian` to xlsx format. Input is guardianInfo object and output-type
which is one of "buffer" or "array" or "binary" or "string" or "base64" (depending what you want to do with the output).

```
const guardianInfo = await getGuardian('0xc5e624d6824e626a6f14457810e794e4603cfee2', ethereumEndpoint);
const guardianXlsx = guardianToXlsx(guardianInfo, 'buffer');
fs.writeFileSync(path, guardianXlsx);
```

* allDelegatorsToXlsx

Used to translate the output of `getAllDelegators` to xlsx format. Input is map of Delegators ({[key: string]: Delegator}) object and output-type
which is one of "buffer" or "array" or "binary" or "string" or "base64" (depending what you want to do with the output).

```
const delegatorMap = await getAllDelegators(ethereumEndpoint)
const delegatorsXlsx = allDelegatorsToXlsx(guardianInfo, 'buffer');
fs.writeFileSync(path, delegatorsXlsx);
```

### Inputs

* Address - Ethereum address of delegator or guardian to test
* EthereumEndpoit - Ethereum url for web3 http provider such as Infura (i.e: https://mainnet.infura.io/v3/<YOUR-INFURA-KEY>)
* NodesEndpoint - a list of one or more ORBS node management status URLs (i.e: http://54.168.36.177/services/management-service/status), these will be queries in order and first one that answers is the one used.
* options (for getDelegator, getGuardian, getDelegatorStakingRewards & getGuardianStakingRewards only) - a modifier object. The default values are shown after each key:
```
{
    read_history: true,          
    read_from_block: 0,
    read_rewards_disable: false,
}
```

| Field                  | Explanation          |
| ---------------------- | -------------------- |
| `read_history`         | Read the historical changes (events) from ethereum event histor and generate the corresponding arrays of values (rewards, stakes, actions etc).<br> Default is `true`<br>A `false` value is quicker but returns only the current state values of the participant (guardian or delegator) | 
| `read_from_block`      | Start block of reading events.<br>Possible Values: 0/-1 - block number of contract deployment (earliest available), positive - block to start from, negative - how many blocks back to start from (i.e. -500 = 500 block before 'latest')<br>Please note you cannot query events from blocks before first contract of the type was deployed.<br>Value has no effect if read_history is set to `false`.    |
| `read_rewards_disable` | Read and calculate rewards slows down respons time so with this field can disable just the stake rewards part.<br> Default is `false`.<br>Value has no effect if read_history is `false`. | 
Please note: 
1) For the functions getDelegatorStakingRewards & getGuardianStakingRewards only the `read_from_block` is used.
2) For function getGuardian when `read_history` is true the whole delegation history is read regardless of the `read_from_block`. This also mean that staking 
history is also read from at least the begining of Delegation contract deployment (In full history mode there may be self-stake event before delegation).

### Outputs
Please have a look at the [model.ts](src/model.ts) for the full output definisions. 

### Contract Deployments Block Numbers
* Orbs ERC20 - 740000
* Staking Contract - 9830000
* Delegation - 11180000
* Rewards - 11145373

## Development

### Download 
```
git clone https://github.com/orbs-network/pos-analytics-lib
cd pos-analytics-lib
```

### Build 
```
npm run build
```

### Clean 
```
npm run clean
```

### Test
The default suite is deterministic and does not require a live RPC endpoint:

```
npm run test
```

The legacy live integration test remains available separately. Set `ETHEREUM_ENDPOINT` and run:

```
npm run test:integration
```
