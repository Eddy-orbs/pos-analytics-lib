/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

export interface PosOptions {
    read_history: boolean;
    read_from_block: number;
    read_rewards_disable: boolean;
    is_polygon: boolean;
}

export interface PosOverview {
    block_number: number;
    block_time: number;
    total_stake: number;
    n_guardians: number;
    n_committee: number;
    n_candidates: number;
    apy: number;
    slices: PosOverviewSlice[]
}

export interface PosOverviewSlice {
    block_number: number;
    block_time: number;
    total_weight: number;
    total_effective_stake: number;
    data: PosOverviewData[];
} 

export interface PosOverviewData {
    name: string;
    address: string;
    effective_stake: number;
    weight: number;
}

export interface Action {
    contract: string;
    event: string;
    block_number: number;
    block_time: number;
    tx_hash: string;
    additional_info_link: string;
    amount?: number;
    current_stake?: number;
    to?: string;
}

export interface Guardian {
    name: string;
    address: string;
    website: string;
    effective_stake: number;
    ip: string;
    certified: boolean;
}

export interface GuardianInfo {
    address: string;
    block_number: number;
    block_time: number;
    read_from_block: number | string;
    details: GuardianDetails;
    stake_status: GuardianStakeStatus;
    reward_status: GuardianRewardStatus;
    stake_slices: GuardianStake[];
    actions: Action[];
    reward_as_guardian_slices: GuardianReward[];
    reward_as_delegator_slices: DelegatorReward[];
    fees_slices: GuardianReward[];
    bootstrap_slices: GuardianReward[];
    delegators: GuardianDelegator[];
    delegators_left: GuardianDelegator[];
}

/**
 * Current Guardian state read directly from the contracts.
 *
 * Unlike {@link GuardianInfo}, this result intentionally contains no event-log
 * history, actions or delegator list.
 */
export interface GuardianCurrent {
    address: string;
    block_number: number;
    block_time: number;
    details: GuardianCurrentDetails;
    stake_status: GuardianStakeStatus;
    reward_status: GuardianCurrentRewardStatus;
}

/** Guardian metadata needed by the visible detail header. */
export interface GuardianCurrentDetails {
    name: string;
    website: string;
    ip: string;
    node_address: string;
    details_URL: string;
    registration_time: number;
    last_update_time: number;
}

/** The Stake screen uses only the configured delegator reward share. */
export interface GuardianCurrentRewardStatus {
    delegator_reward_share: number;
}

export interface GuardianDetails {
    name: string;
    website: string;
    ip: string;
    node_address: string;
    details_URL: string;
    registration_time: number;
    last_update_time: number;
    certified: boolean;
}

export interface GuardianStakeStatus {
    self_stake: number;
    cooldown_stake: number;
    current_cooldown_time: number;
    non_stake: number;
    delegated_stake: number;
    total_stake: number;
}

export interface GuardianRewardStatus {
    guardian_rewards_balance: number;
    guardian_rewards_claimed: number;
    total_guardian_rewards: number;
    delegator_rewards_balance: number;
    delegator_rewards_claimed: number;
    total_delegator_rewards: number;
    fees_balance: number;
    fees_claimed: number;
    total_fees: number;
    bootstrap_balance: number;
    bootstrap_claimed: number;
    total_bootstrap: number;
    delegator_reward_share: number;
}

export interface GuardianStake {
    block_number: number;
    block_time: number;
    self_stake: number;
    delegated_stake: number; // Unlike the contract aggregate, this excludes self stake.
    total_stake: number;
    n_delegates: number;
    /** Event identity is present for exact event-reconstruction points. */
    transaction_hash?: string;
    log_index?: number;
}

export interface GuardianAction extends Action {}

export interface GuardianReward {
    block_number: number;
    block_time: number;
    tx_hash: string;
    additional_info_link: string;
    total_awarded: number;
}

export interface GuardianDelegator {
    last_change_block: number;
    last_change_time: number;
    address: string;
    stake: number;
    non_stake: number;
}

export interface Delegator extends GuardianDelegator {
    delegated_to: string;
}

export interface DelegatorInfo {
    address: string;
    block_number: number;
    block_time: number;
    read_from_block: number | string;
    total_stake: number;
    cooldown_stake: number;
    current_cooldown_time: number;
    non_stake: number;
    delegated_to: string;
    rewards_balance: number;
    rewards_claimed: number;
    total_rewards: number;
    stake_slices: DelegatorStake[];
    actions: Action[];
    reward_slices: DelegatorReward[];
}

/**
 * Current Delegator state read directly from the contracts.
 *
 * Unlike {@link DelegatorInfo}, this result intentionally contains no
 * event-log history or actions.
 */
export interface DelegatorCurrent {
    address: string;
    block_number: number;
    block_time: number;
    total_stake: number;
    cooldown_stake: number;
    current_cooldown_time: number;
    non_stake: number;
    delegated_to: string;
}

/** Inclusive block range represented by a history response. */
export interface HistoryRange {
    from_block: number;
    to_block: number;
    from_time?: number;
    to_time?: number;
}

/** Describes which parts of a range-scoped history are exact. */
export interface StakeHistoryDataQuality {
    /** True only when every stake-domain value is exact for the entire range. */
    exact: boolean;
    /** Whether stake/cooldown values are exact for the entire range. */
    stake_values_exact: boolean;
    /** Whether the synthetic value at the start of the range is exact. */
    anchor_exact: boolean;
    /** How the synthetic value at the start of the range was obtained. */
    anchor_source: 'current-state-reverse' | 'prior-event' | 'first-event' | 'chain-start' | 'current-flat' | 'first-event-backfill' | 'archive-state-call';
    /** The data acquisition strategy used for this response. */
    mode?: 'event-reconstruction' | 'sampled-state';
    /** Transport used to obtain exact stake event points. */
    event_source?: 'rpc-logs' | 'subgraph+rpc-logs';
    /** Whether requested timestamps were mapped to exact or estimated blocks. */
    block_resolution?: 'exact' | 'linear-estimate-one-step-correction';
    /** True when every historical stake value came from an archive eth_call. */
    sampled_state?: boolean;
    /** Whether an exact active-delegator count was reconstructed for every point. */
    n_delegates_available?: boolean;
    /** Source used to seed and incrementally reconstruct the active count. */
    n_delegates_source?: 'subgraph-checkpoint+range-events' | 'unavailable';
    /** Block represented by the active-delegator checkpoint, when available. */
    n_delegates_checkpoint_block?: number;
    notes?: string[];
}

/** Range-scoped Guardian stake history for lazy-loading chart data. */
export interface GuardianStakeHistory {
    address: string;
    range: HistoryRange;
    stake_slices: GuardianStake[];
    data_quality: StakeHistoryDataQuality;
}

/** Range-scoped Delegator stake history for lazy-loading chart data. */
export interface DelegatorStakeHistory {
    address: string;
    range: HistoryRange;
    stake_slices: DelegatorStake[];
    data_quality: StakeHistoryDataQuality;
}

export interface DelegatorStake {
    block_number: number;
    block_time: number;
    stake: number;
    cooldown: number;
    /** Event identity is omitted only for synthetic range/current anchors. */
    transaction_hash?: string;
    log_index?: number;
}

export interface DelegatorAction extends Action {}

export interface DelegatorReward extends GuardianReward {
    guardian_from: string;
}
