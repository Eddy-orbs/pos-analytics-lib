import assert from 'assert';
import {resolveBlockAtOrAfterTimestamp} from './block-time';

interface FakeChain {
    web3: any;
    calls: Array<number | string>;
}

function fakeChain(chainId: number, firstNumber: number, firstTime: number, blockCount: number, secondsPerBlock: number): FakeChain {
    const calls: Array<number | string> = [];
    const latestNumber = firstNumber + blockCount - 1;
    const block = (number: number): any => ({
        number,
        timestamp: firstTime + (number - firstNumber) * secondsPerBlock
    });
    return {
        calls,
        web3: {
            eth: {
                getChainId: async () => chainId,
                getBlock: async (number: number | string) => {
                    calls.push(number);
                    return block(number === 'latest' ? latestNumber : Number(number));
                }
            }
        }
    };
}

async function testBinarySearchAndBoundaries(): Promise<void> {
    const firstNumber = 9830000;
    const firstTime = 1586328645;
    const chain = fakeChain(1, firstNumber, firstTime, 101, 12);

    assert.strictEqual(await resolveBlockAtOrAfterTimestamp(chain.web3, firstTime - 1, {finalityBlocks: 0}), firstNumber);
    assert.strictEqual(await resolveBlockAtOrAfterTimestamp(chain.web3, firstTime + 25, {finalityBlocks: 0}), firstNumber + 3);
    const exact = await resolveBlockAtOrAfterTimestamp(chain.web3, firstTime + 48, {
        finalityBlocks: 0,
        returnBlockInfo: true
    });
    assert.deepStrictEqual(exact, {block_number: firstNumber + 4, block_time: firstTime + 48});
    assert.strictEqual(await resolveBlockAtOrAfterTimestamp(chain.web3, firstTime + 99999, {finalityBlocks: 0}), firstNumber + 100);
}

async function testChainAwareFinalityHead(): Promise<void> {
    const firstNumber = 25487295;
    const firstTime = 1646207643;
    const chain = fakeChain(137, firstNumber, firstTime, 401, 2);
    // Polygon excludes 256 blocks by default, so the safe head is first + 144.
    const result = await resolveBlockAtOrAfterTimestamp(chain.web3, firstTime + 10000, {returnBlockInfo: true});
    assert.deepStrictEqual(result, {block_number: firstNumber + 144, block_time: firstTime + 288});
}

async function testExactResolutionCache(): Promise<void> {
    const firstNumber = 9830000;
    const firstTime = 1586328645;
    const chain = fakeChain(1, firstNumber, firstTime, 20, 12);
    const target = firstTime + 37;
    const first = await resolveBlockAtOrAfterTimestamp(chain.web3, target, {finalityBlocks: 0});
    const callsAfterFirst = chain.calls.length;
    const second = await resolveBlockAtOrAfterTimestamp(chain.web3, target, {finalityBlocks: 0, returnBlockInfo: true});
    assert.strictEqual(first, firstNumber + 4);
    assert.deepStrictEqual(second, {block_number: firstNumber + 4, block_time: firstTime + 48});
    assert.strictEqual(chain.calls.length, callsAfterFirst);
}

async function testAbort(): Promise<void> {
    const chain = fakeChain(1, 9830000, 1586328645, 20, 12);
    let received: any;
    try {
        await resolveBlockAtOrAfterTimestamp(chain.web3, 1586328700, {signal: {aborted: true} as AbortSignal});
    } catch (error) {
        received = error;
    }
    assert.strictEqual(received && received.name, 'AbortError');
    assert.strictEqual(chain.calls.length, 0);
}

async function testRateLimitAndTransientRetries(): Promise<void> {
    const delays: number[] = [];
    let chainAttempts = 0;
    let latestAttempts = 0;
    const firstNumber = 9830000;
    const firstTime = 1586328645;
    const web3: any = {
        eth: {
            getChainId: async () => {
                chainAttempts += 1;
                if (chainAttempts === 1) {
                    const error: any = new Error('Service unavailable');
                    error.status = 503;
                    throw error;
                }
                return 1;
            },
            getBlock: async (number: number | string) => {
                if (number === 'latest') {
                    latestAttempts += 1;
                    if (latestAttempts < 3) {
                        const error: any = new Error('Too many requests');
                        error.status = 429;
                        throw error;
                    }
                    return {number: firstNumber + 10, timestamp: firstTime + 120};
                }
                return {number, timestamp: firstTime + (Number(number) - firstNumber) * 12};
            }
        }
    };
    const result = await resolveBlockAtOrAfterTimestamp(web3, firstTime - 1, {
        finalityBlocks: 0,
        maxRateLimitRetries: 2,
        maxRetryableRetries: 1,
        baseRetryDelayMs: 10,
        maxRetryDelayMs: 100,
        retryJitterMs: 0,
        dependencies: {
            sleep: async (milliseconds: number) => { delays.push(milliseconds); },
            random: () => 0,
            now: () => 0
        }
    });
    assert.strictEqual(result, firstNumber);
    assert.strictEqual(chainAttempts, 2);
    assert.strictEqual(latestAttempts, 3);
    assert.deepStrictEqual(delays, [10, 10, 20]);
}

async function testRetryLimitIsBounded(): Promise<void> {
    let attempts = 0;
    const delays: number[] = [];
    const web3: any = {
        eth: {
            getChainId: async () => {
                attempts += 1;
                const error: any = new Error('Too many requests');
                error.status = 429;
                throw error;
            }
        }
    };
    let received: any;
    try {
        await resolveBlockAtOrAfterTimestamp(web3, 1586328645, {
            maxRateLimitRetries: 2,
            baseRetryDelayMs: 10,
            retryJitterMs: 0,
            dependencies: {
                sleep: async (milliseconds: number) => { delays.push(milliseconds); },
                random: () => 0,
                now: () => 0
            }
        });
    } catch (error) {
        received = error;
    }
    assert.ok(received);
    assert.strictEqual(received.status, 429);
    assert.strictEqual(attempts, 3);
    assert.deepStrictEqual(delays, [10, 20]);
}

async function testRetryBackoffIsAbortAware(): Promise<void> {
    const controller = new AbortController();
    let attempts = 0;
    const web3: any = {
        eth: {
            getChainId: async () => {
                attempts += 1;
                const error: any = new Error('Too many requests');
                error.status = 429;
                throw error;
            }
        }
    };
    let received: any;
    try {
        await resolveBlockAtOrAfterTimestamp(web3, 1586328645, {
            signal: controller.signal,
            dependencies: {
                sleep: async () => {
                    controller.abort();
                    await new Promise<void>(() => undefined);
                },
                random: () => 0,
                now: () => 0
            }
        });
    } catch (error) {
        received = error;
    }
    assert.strictEqual(received && received.name, 'AbortError');
    assert.strictEqual(attempts, 1);
}

async function testResolutionCacheIsFinalityAware(): Promise<void> {
    const firstNumber = 9830000;
    const firstTime = 1586328645;
    const chain = fakeChain(1, firstNumber, firstTime, 101, 12);
    const target = firstTime + 92 * 12;
    const noFinality = await resolveBlockAtOrAfterTimestamp(chain.web3, target, {finalityBlocks: 0});
    const safeHead = await resolveBlockAtOrAfterTimestamp(chain.web3, target, {finalityBlocks: 20});
    assert.strictEqual(noFinality, firstNumber + 92);
    assert.strictEqual(safeHead, firstNumber + 80);
}

async function testOptionalSuccessfulCallPacing(): Promise<void> {
    const starts: number[] = [];
    const delays: number[] = [];
    let clock = 0;
    const firstNumber = 9830000;
    const firstTime = 1586328645;
    const web3: any = {
        eth: {
            getChainId: async () => {
                starts.push(clock);
                return 1;
            },
            getBlock: async (number: number | string) => {
                starts.push(clock);
                if (number === 'latest') return {number: firstNumber + 10, timestamp: firstTime + 120};
                return {number, timestamp: firstTime + (Number(number) - firstNumber) * 12};
            }
        }
    };
    await resolveBlockAtOrAfterTimestamp(web3, firstTime - 1, {
        finalityBlocks: 0,
        minRequestIntervalMs: 5,
        dependencies: {
            sleep: async (milliseconds: number) => {
                delays.push(milliseconds);
                clock += milliseconds;
            },
            random: () => 0,
            now: () => clock
        }
    });
    assert.deepStrictEqual(starts, [0, 5, 10]);
    assert.deepStrictEqual(delays, [5, 5]);
}

async function run(): Promise<void> {
    await testBinarySearchAndBoundaries();
    await testChainAwareFinalityHead();
    await testExactResolutionCache();
    await testAbort();
    await testRateLimitAndTransientRetries();
    await testRetryLimitIsBounded();
    await testRetryBackoffIsAbortAware();
    await testResolutionCacheIsFinalityAware();
    await testOptionalSuccessfulCallPacing();
    console.log('block-time tests passed');
}

run().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
});
