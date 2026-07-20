import { EventQueryOptions } from '../query/event-reader';

/** Current Delegator payload accepted from getDelegatorCurrent(). */
export interface DelegatorStakeHistoryCurrentSnapshot {
    address: string;
    block_number: number;
    block_time: number;
    total_stake: number;
    cooldown_stake: number;
}

/** Current Guardian payload accepted from getGuardianCurrent(). */
export interface GuardianStakeHistoryCurrentSnapshot {
    address: string;
    block_number: number;
    block_time: number;
    stake_status: {
        self_stake: number;
        delegated_stake: number;
        total_stake: number;
    };
}

/**
 * Exact state immediately before an incremental Guardian history range.
 * Supplying it avoids a backwards event-log lookup when a caller already
 * owns the previous cached range.
 */
export interface GuardianStakeHistoryAnchorSnapshot {
    block_number: number;
    block_time: number;
    stake_status: {
        self_stake: number;
        delegated_stake: number;
        total_stake: number;
    };
}

/**
 * Inclusive block range requested by a lazy-loaded stake chart.
 *
 * Historical contract state is not available through the current-state
 * multicall, so the RPC implementation currently requires `to_block` to be
 * the same stable head returned by that multicall. Omitting it is preferred.
 */
export interface StakeHistoryQuery {
    /** Inclusive block start. Required for pure-RPC and incremental reads. */
    from_block?: number;
    /**
     * UTC Unix timestamp used to seed an indexed history range without
     * browser-side timestamp-to-block RPC probing. Requires a Subgraph path.
     */
    from_time?: number;
    to_block?: number;
    /**
     * Optional Subgraph-compatible service base URL. Delegator event history
     * uses it for immutable history and reads only the recent head from RPC.
     */
    subgraph_base_url?: string;
    /**
     * Optional UTC Unix timestamps to sample with archive `eth_call`.
     *
     * When supplied (including an empty array), history is read from contract
     * state at a bounded set of estimated block tags. Event logs are not read.
     * Values must be sorted in ascending order.
     */
    sample_timestamps?: number[];
    /**
     * Reuses the matching getDelegatorCurrent/getGuardianCurrent response in
     * sampled mode, avoiding a second current-state multicall.
     */
    current_snapshot?: DelegatorStakeHistoryCurrentSnapshot | GuardianStakeHistoryCurrentSnapshot;
    /** Cached state immediately before `from_block`, for incremental Guardian refreshes. */
    guardian_anchor_snapshot?: GuardianStakeHistoryAnchorSnapshot;
    /** Minimum delay between archive state RPC calls. Defaults to 75ms. */
    state_call_interval_ms?: number;
    /** Maximum retries for provider rate-limit responses. Defaults to 4. */
    state_call_max_rate_limit_retries?: number;
    /** Maximum retries for transient RPC/network responses. Defaults to 2. */
    state_call_max_retryable_retries?: number;
    /** Initial exponential retry delay. Defaults to 250ms. */
    state_call_base_retry_delay_ms?: number;
    /** Maximum exponential retry delay. Defaults to 4000ms. */
    state_call_max_retry_delay_ms?: number;
    /** Random retry jitter upper bound. Defaults to 100ms. */
    state_call_retry_jitter_ms?: number;
    /** Cancels block resolution and archive state calls. */
    signal?: AbortSignal;
    /** Maximum number of blocks inspected for a Guardian anchor event. */
    anchor_lookback_blocks?: number;
    /** Adaptive chunk/retry controls used by the event reader. */
    event_query_options?: EventQueryOptions;
}
