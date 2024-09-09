import {
  Address,
  LoggerConstructor,
  Logger,
  Token,
  PoolPrices,
  ExchangePrices,
  UnoptimizedRate,
  TransferFeeParams,
} from './types';
import {
  SwapSide,
  SETUP_RETRY_TIMEOUT,
  FETCH_POOL_IDENTIFIER_TIMEOUT,
  FETCH_POOL_PRICES_TIMEOUT,
} from './constants';
import { DexAdapterService } from './dex';
import { IDex, IRouteOptimizer } from './dex/idex';
import { isSrcTokenTransferFeeToBeExchanged } from './utils';

export class PricingHelper {
  logger: Logger;
  public optimizeRate: IRouteOptimizer<UnoptimizedRate>;

  constructor(
    protected dexAdapterService: DexAdapterService,
    loggerConstructor: LoggerConstructor,
  ) {
    this.logger = loggerConstructor(
      `PricingHelper_${dexAdapterService.network}`,
    );
    this.optimizeRate = (ur: UnoptimizedRate) =>
      this.dexAdapterService.routeOptimizers.reduce(
        (acc: UnoptimizedRate, fn: IRouteOptimizer<UnoptimizedRate>) => fn(acc),
        ur,
      );
  }

  private async initializeDex(dexKey: string, blockNumber: number) {
    try {
      const dexInstance = this.dexAdapterService.getDexByKey(dexKey);

      if (!dexInstance.initializePricing) return;

      if (
        !this.dexAdapterService.dexHelper.config.isSlave &&
        dexInstance.cacheStateKey
      ) {
        this.logger.info(`remove cached state ${dexInstance.cacheStateKey}`);
        this.dexAdapterService.dexHelper.cache.rawdel(
          dexInstance.cacheStateKey,
        );
      }

      await dexInstance.initializePricing(blockNumber);
      this.logger.info(`${dexKey}: is successfully initialized`);
    } catch (e) {
      this.logger.error(`Error_startListening_${dexKey}:`, e);
      setTimeout(
        () => this.initializeDex(dexKey, blockNumber),
        SETUP_RETRY_TIMEOUT,
      );
    }
  }

  public getAllDexKeys(): string[] {
    return this.dexAdapterService.getAllDexKeys();
  }

  public getDexByKey(key: string): IDex<any, any, any> | null {
    try {
      return this.dexAdapterService.getDexByKey(key);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Invalid Dex Key')) {
        this.logger.warn(`Dex ${key} was not found in getDexByKey`);
        return null;
      }
      // Unexpected error
      throw e;
    }
  }

  public async initialize(blockNumber: number, dexKeys: string[]) {
    return await Promise.all(
      dexKeys.map(key => this.initializeDex(key, blockNumber)),
    );
  }

  public async releaseResources(dexKeys: string[]) {
    return await Promise.all(dexKeys.map(key => this.releaseDexResources(key)));
  }

  private async releaseDexResources(dexKey: string) {
    try {
      const dexInstance = this.dexAdapterService.getDexByKey(dexKey);

      if (!dexInstance.releaseResources) return;

      await dexInstance.releaseResources();
      this.logger.info(`${dexKey}: resources were successfully released`);
    } catch (e) {
      this.logger.error(`Error_releaseResources_${dexKey}:`, e);
      setTimeout(() => this.releaseDexResources(dexKey), SETUP_RETRY_TIMEOUT);
    }
  }

  public async getPoolIdentifiers(
    from: Token,
    to: Token,
    side: SwapSide,
    blockNumber: number,
    dexKeys: string[],
    filterConstantPricePool: boolean = false,
    overrideTimeout?: number,
  ): Promise<{ [dexKey: string]: string[] | null }> {
    const poolIdentifiers = await Promise.all(
      dexKeys.map(async key => {
        try {
          return await new Promise<string[] | null>((resolve, reject) => {
            const now = Date.now();
            const timeout = overrideTimeout ?? FETCH_POOL_IDENTIFIER_TIMEOUT;
            const timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Timeout of ${timeout}ms breached after ${
                      Date.now() - now
                    }ms for ${key}`,
                  ),
                ),
              timeout,
            );
            const dexInstance = this.dexAdapterService.getDexByKey(key);

            if (
              filterConstantPricePool &&
              dexInstance.hasConstantPriceLargeAmounts
            ) {
              clearTimeout(timer);
              return resolve(null);
            }

            return dexInstance
              .getPoolIdentifiers(from, to, side, blockNumber)
              .then(resolve, reject)
              .finally(() => {
                clearTimeout(timer);
              });
          });
        } catch (e) {
          this.logger.error(`Error_${key}_getPoolIdentifiers:`, e);
          return [];
        }
      }),
    );

    return dexKeys.reduce(
      (
        acc: { [dexKey: string]: string[] | null },
        dexKey: string,
        index: number,
      ) => {
        acc[dexKey] = poolIdentifiers[index];
        return acc;
      },
      {},
    );
  }

  getDexsSupportingFeeOnTransfer(): string[] {
    const allDexKeys = this.dexAdapterService.getAllDexKeys();
    return allDexKeys
      .map(dexKey => {
        try {
          const dexInstance = this.dexAdapterService.getDexByKey(dexKey);
          if (dexInstance.isFeeOnTransferSupported) {
            return dexKey;
          }
        } catch (e) {
          if (
            !(e instanceof Error && e.message.startsWith(`Invalid Dex Key`))
          ) {
            throw e;
          }
        }
      })
      .filter((d: string | undefined): d is string => !!d);
  }

  public async getPoolPrices(
    from: Token,
    to: Token,
    amounts: bigint[],
    side: SwapSide,
    blockNumber: number,
    dexKeys: string[],
    limitPoolsMap: { [key: string]: string[] | null } | null,
    transferFees: TransferFeeParams = {
      srcFee: 0,
      destFee: 0,
      srcDexFee: 0,
      destDexFee: 0,
    },
    rollupL1ToL2GasRatio?: number,
    overrideTimeout?: number,
    fmode?: boolean,
  ): Promise<PoolPrices<any>[]> {
    const start = Date.now();
    const token_key = `${Math.round(Math.random() * 10_000)}_${from.address}_${
      to.address
    }`.toLowerCase();

    const dexPoolPrices = await Promise.all(
      dexKeys.map(async key => {
        const start = Date.now();
        try {
          const limitPools = limitPoolsMap ? limitPoolsMap[key] : null;

          if (limitPools && !limitPools.length) return [];

          return await new Promise<PoolPrices<any>[] | null>(
            (resolve, reject) => {
              const now = Date.now();
              const timeout = overrideTimeout ?? FETCH_POOL_PRICES_TIMEOUT;
              const timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Timeout of ${timeout}ms breached after ${
                        Date.now() - now
                      }ms for ${key}`,
                    ),
                  ),
                timeout,
              );

              const dexInstance = this.dexAdapterService.getDexByKey(key);

              if (
                isSrcTokenTransferFeeToBeExchanged(transferFees) &&
                !dexInstance.isFeeOnTransferSupported
              ) {
                clearTimeout(timer);
                return resolve(null);
              }

              const timerKey = `getPricesVolume_${key}_${from.address}_${
                to.address
              }_${amounts[amounts.length - 1]}_${Math.floor(
                Math.random() * 1e6,
              )}`;
              // eslint-disable-next-line no-console
              console.time(timerKey);
              dexInstance
                .getPricesVolume(
                  from,
                  to,
                  amounts,
                  side,
                  blockNumber,
                  limitPools ? limitPools : undefined,
                  transferFees,
                  false,
                  fmode,
                )
                .then(poolPrices => {
                  // eslint-disable-next-line no-console
                  console.timeEnd(timerKey);
                  try {
                    if (!poolPrices || !rollupL1ToL2GasRatio) {
                      return resolve(poolPrices);
                    }
                    return resolve(
                      poolPrices.map(pp => {
                        pp.gasCostL2 = pp.gasCost;
                        const gasCostL1 = dexInstance.getCalldataGasCost(pp);
                        if (
                          typeof pp.gasCost === 'number' &&
                          typeof gasCostL1 === 'number'
                        ) {
                          pp.gasCost += Math.ceil(
                            rollupL1ToL2GasRatio * gasCostL1,
                          );
                        } else if (
                          typeof pp.gasCost !== 'number' &&
                          typeof gasCostL1 !== 'number'
                        ) {
                          if (pp.gasCost.length !== gasCostL1.length) {
                            throw new Error(
                              `getCalldataGasCost returned wrong array length in dex ${key}`,
                            );
                          }
                          pp.gasCost = pp.gasCost.map(
                            (g, i) =>
                              g +
                              Math.ceil(rollupL1ToL2GasRatio * gasCostL1[i]),
                          );
                        } else {
                          throw new Error(
                            `getCalldataGasCost returned wrong type in dex ${key}`,
                          );
                        }
                        return pp;
                      }),
                    );
                  } catch (e) {
                    reject(e);
                  }
                }, reject)
                .finally(() => {
                  this.logger.info(
                    `{benchmarks} (total-for-dex) [finally]: Dex ${key}, tokenPair: ${token_key} took ${
                      end - start
                    }ms to resolve/reject`,
                  );
                  clearTimeout(timer);
                });
            },
          );
        } catch (e) {
          this.logger.error(
            `{benchmarks} (limited-by-timeout-for-dex) [error]: Dex ${key}, tokenPair: ${token_key} took ${
              end - start
            }ms to resolve/reject`,
            e,
          );
          return [];
        } finally {
          const end = Date.now();
          this.logger.info(
            `{benchmarks} (limited-by-timeout-for-dex) [finally]: Dex ${key}, tokenPair: ${token_key} took ${
              end - start
            }ms to resolve/reject`,
          );
        }
      }),
    );

    const prices = dexPoolPrices
      .filter((x): x is ExchangePrices<any> => !!x)
      .flat() // flatten to get all the pools for the swap
      .filter(p => {
        // Pools should only return correct chunks
        if (p.prices.length !== amounts.length) {
          this.logger.error(
            `Error_getPoolPrices: ${p.exchange} returned prices with invalid chunks`,
          );
          return false;
        }

        if (Array.isArray(p.gasCost)) {
          if (p.gasCost.length !== amounts.length) {
            this.logger.error(
              `Error_getPoolPrices: ${p.exchange} returned prices with invalid gasCost array length: ${p.gasCost.length} !== ${amounts.length}`,
            );
            return false;
          }

          for (const [i, amount] of amounts.entries()) {
            if (amount === 0n && p.gasCost[i] !== 0) {
              this.logger.error(
                `Error_getPoolPrices: ${p.exchange} returned prices with invalid gasCost array. At index ${i} amount is 0 but gasCost is ${p.gasCost[i]}`,
              );
              return false;
            }
          }
        }

        if (p.prices.every(pi => pi === 0n)) {
          return false;
        }
        return true;
      });

    const end = Date.now();
    this.logger.info(
      `{benchmarks} (getPoolPrices) [finally]: Dex ${''}, tokenPair: ${token_key} took ${
        end - start
      }ms to resolve/reject`,
    );

    return prices;
  }
}
