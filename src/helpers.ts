/**
 * Copyright 2020 the pos-analytics authors
 * This file is part of the pos-analytics library in the Orbs project.
 *
 * This source code is licensed under the MIT license found in the LICENSE file in the root directory of this source tree.
 * The above notice should be included in all copies or substantial portions of the software.
 */

import _ from 'lodash';
import BigNumber from 'bignumber.js';
// import fetch from 'node-fetch';
import { retry } from 'ts-retry-promise';
import { PosOptions } from './model';
import {fetchSubgraphGraphQl, getSubgraphUrl} from './subgraph/client';

export const DECIMALS = '1e18';
export function bigToNumber(n: BigNumber):number {
  return n.dividedBy(DECIMALS).toNumber();
}

// returns UTC clock time in seconds (similar to unix timestamp / Ethereum block time / RefTime)
export function getCurrentClockTime() {
  return Math.round(new Date().getTime() / 1000);
}

export async function fetchJson(url: string) {
  return retry(
    async () => {
      const response = await fetch(url);
      if (response.ok && String(response.headers.get('content-type')).toLowerCase().includes('application/json')) {
        try {
          const res = await response.json();
          if (res.error) {
            throw new Error(`Invalid response for url '${url}`);
          }
          return res;
        } catch (e) {
          throw new Error(`Invalid response for url '${url}`);
        }  
      } else {
        throw new Error(`Invalid response for url '${url}': Status Code: ${response.status}, Content-Type: ${response.headers.get('content-type')}, Content: ${await response.text()}`);
      }
    },
    { retries: 3, delay: 300 }
  );
}

function byte(value: number, byteIdx: number) {
  const shift = byteIdx * 8;
  return ((value & (0xff << shift)) >> shift) & 0xff;
}

export function getIpFromHex(ipStr: string): string {
  const ipBytes = Number(ipStr);
  return byte(ipBytes, 3) + '.' + byte(ipBytes, 2) + '.' + byte(ipBytes, 1) + '.' + byte(ipBytes, 0);
}

export function parseOptions(input?: any): PosOptions {
  const read_history = input?.read_history === undefined ? true : new Boolean(input.read_history).valueOf();
  const read_from_block = _.isNumber(input?.read_from_block) ? new Number(input.read_from_block).valueOf() : 0;
  const read_rewards_disable = new Boolean(input?.read_rewards_disable).valueOf(); // default is to read
  const is_polygon = input?.is_polygon;

  return {
    read_history,
    read_from_block,
    read_rewards_disable,
    is_polygon
  };
}

export function optionsStartFromText(options: PosOptions, currentBlockNumber: number) : number | string {
  if (options.read_from_block === 0 || options.read_from_block === -1) return 'Earliest Possible';
  return options.read_from_block < 0 ? currentBlockNumber+options.read_from_block : options.read_from_block;
}

export async function querySubgraph(chainId: number, query: string, variables: any, subgraphBaseUrl?: string) {
  const subgraphUrl = getSubgraphUrl(chainId, subgraphBaseUrl);
  const PAGE_SIZE = 100;
  let allResults: any[] = [];
  let hasMore = true;
  let skip = 0;

  // Extract the query name from the query string
  const queryName = query.match(/query\s*\([^)]*\)\s*{\s*(\w+)/)?.[1];
  if (!queryName) {
    throw new Error('Unable to extract query name from the query string');
  }

  while (hasMore) {
    const paginatedQuery = query.replace(
        `${queryName}(`,
        `${queryName}(first: ${PAGE_SIZE}, skip: ${skip},`
    );

    const data = await fetchSubgraphGraphQl(subgraphUrl, paginatedQuery, variables);
    const results = data[queryName];
    if (!Array.isArray(results)) throw new Error(`Subgraph response '${queryName}' is invalid`);
    allResults = allResults.concat(results);

    if (results.length < PAGE_SIZE) {
      hasMore = false;
    } else {
      skip += PAGE_SIZE;
    }
  }

  return allResults;
}
