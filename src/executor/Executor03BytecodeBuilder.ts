import { ethers } from 'ethers';
import { DexExchangeParam } from '../types';
import { Address, OptimalRate, OptimalSwap } from '@paraswap/core';
import { isETHAddress } from '../utils';
import { DepositWithdrawReturn, WethFunctions } from '../dex/weth/types';
import { Executors, Flag, SpecialDex } from './types';
import { BYTES_96_LENGTH, ZEROS_28_BYTES } from './constants';
import { ExecutorBytecodeBuilder } from './ExecutorBytecodeBuilder';
import { MAX_UINT } from '../constants';

const {
  utils: { hexlify, hexDataLength, hexConcat, hexZeroPad, solidityPack },
} = ethers;

/**
 * Class to build bytecode for Executor03 - simpleSwap (SINGLE_STEP) with 100% on a path and multiSwap with 100% amounts on each path (HORIZONTAL_SEQUENCE)
 */
export class Executor03BytecodeBuilder extends ExecutorBytecodeBuilder {
  type = Executors.THREE;
  /**
   * Executor03 Flags:
   * switch (flag % 4):
   * case 0: don't instert fromAmount
   * case 1: sendEth equal to fromAmount
   * case 2: sendEth equal to fromAmount + insert fromAmount
   * case 3: insert fromAmount

   * switch (flag % 3):
   * case 0: don't check balance after swap
   * case 1: check eth balance after swap
   * case 2: check destToken balance after swap
   */
  protected buildSimpleSwapFlags(
    priceRoute: OptimalRate,
    exchangeParam: DexExchangeParam,
    index: number,
    maybeWethCallData?: DepositWithdrawReturn,
  ): { dexFlag: Flag; approveFlag: Flag } {
    const { srcToken, destToken } = priceRoute.bestRoute[0].swaps[index];
    const isEthSrc = isETHAddress(srcToken);
    const isEthDest = isETHAddress(destToken);

    const isLastSwap =
      index === priceRoute.bestRoute[0].swaps[0].swapExchanges.length - 1;

    const { dexFuncHasRecipient, needWrapNative } = exchangeParam;

    const needWrap = needWrapNative && isEthSrc && maybeWethCallData?.deposit;
    const needUnwrap =
      needWrapNative && isEthDest && maybeWethCallData?.withdraw;

    let dexFlag = Flag.ZERO; // (flag 0 mod 4) = case 0: don't insert fromAmount,toAmount (flag 0 mod 3) = case 0: don't check balance after swap
    let approveFlag = Flag.ZERO; // (flag 0 mod 4) = case 0: don't insert fromAmount,toAmount (flag 0 mod 3) = case 0: don't check balance after swap

    if (isEthSrc && !needWrap) {
      dexFlag = Flag.FIVE; // (flag 5 mod 4) = case 1: sendEth equal to fromAmount, (flag 5 mod 3) = case 2: check "srcToken" balance after swap
    } else if (isEthDest && !needUnwrap) {
      dexFlag = Flag.FOUR; // (flag 4 mod 4) = case 0: don't insert fromAmount, (flag 4 mod 3) = case 1: check eth balance after swap
    } else if (!dexFuncHasRecipient || (isEthDest && needUnwrap)) {
      dexFlag = Flag.EIGHT; // (flag 8 mod 4) = case 0: don't insert fromAmount, (flag 8 mod 3) = case 2: check "srcToken" balance after swap
      // dexFlag = Flag.ZERO;
    }

    return {
      dexFlag,
      approveFlag,
    };
  }

  protected buildMultiSwapFlags(
    priceRoute: OptimalRate,
    exchangeParam: DexExchangeParam,
    index: number,
    maybeWethCallData?: DepositWithdrawReturn,
  ): { dexFlag: Flag; approveFlag: Flag } {
    return { dexFlag: Flag.ZERO, approveFlag: Flag.ZERO };
  }

  protected buildSingleSwapCallData(
    priceRoute: OptimalRate,
    exchangeParams: DexExchangeParam[],
    index: number,
    flags: { approves: Flag[]; dexes: Flag[]; wrap: Flag },
    sender: string,
    maybeWethCallData: DepositWithdrawReturn | undefined,
    swap: OptimalSwap,
  ): string {
    let swapCallData = '';

    const curExchangeParam = exchangeParams[index];

    const dexCallData = this.buildDexCallData(
      swap,
      curExchangeParam,
      index,
      flags.dexes[index],
    );

    swapCallData = hexConcat([dexCallData]);

    if (
      flags.dexes[index] % 4 !== 1 && // not sendEth
      !isETHAddress(swap.srcToken)
    ) {
      const approve = this.erc20Interface.encodeFunctionData('approve', [
        curExchangeParam.targetExchange,
        MAX_UINT,
      ]);

      const approveCallData = this.buildApproveCallData(
        approve,
        isETHAddress(swap.srcToken) && index !== 0
          ? this.dexHelper.config.data.wrappedNativeTokenAddress
          : swap.srcToken,
        MAX_UINT,
        flags.approves[index],
      );

      swapCallData = hexConcat([approveCallData, swapCallData]);
    }

    if (
      maybeWethCallData?.deposit &&
      // do deposit only for the first path with wrapping
      exchangeParams.findIndex(p => p.needWrapNative) === index
    ) {
      const approveWethCalldata = this.buildApproveCallData(
        this.erc20Interface.encodeFunctionData('approve', [
          curExchangeParam.targetExchange,
          MAX_UINT,
        ]),
        this.dexHelper.config.data.wrappedNativeTokenAddress,
        MAX_UINT,
        flags.approves[index],
      );

      const depositCallData = this.buildWrapEthCallData(
        maybeWethCallData.deposit.calldata,
        Flag.NINE,
      );

      swapCallData = hexConcat([
        approveWethCalldata,
        depositCallData,
        swapCallData,
      ]);
    }

    // after the last path
    if (index === exchangeParams.length - 1) {
      // if some of dexes doesn't have recipient add one transfer in the end
      if (
        exchangeParams.some(param => !param.dexFuncHasRecipient) &&
        !isETHAddress(swap.destToken)
      ) {
        const transferCallData = this.buildTransferCallData(
          this.erc20Interface.encodeFunctionData('transfer', [
            this.dexHelper.config.data.augustusV6Address,
            // insert 0 because it's still gonna be replaced with balance check result
            '0',
          ]),
          swap.destToken,
        );

        swapCallData = hexConcat([swapCallData, transferCallData]);
      }

      // withdraw WETH
      if (isETHAddress(swap.destToken) && maybeWethCallData?.withdraw) {
        const withdrawCallData = this.buildUnwrapEthCallData(
          maybeWethCallData.withdraw.calldata,
        );
        swapCallData = hexConcat([swapCallData, withdrawCallData]);
      }

      // send ETH to augustus
      if (
        isETHAddress(swap.destToken) &&
        (!curExchangeParam.dexFuncHasRecipient || maybeWethCallData?.withdraw)
      ) {
        const finalSpecialFlagCalldata = this.buildFinalSpecialFlagCalldata();
        swapCallData = hexConcat([swapCallData, finalSpecialFlagCalldata]);
      }
    }

    return this.addMetadata(
      swapCallData,
      swap.swapExchanges[index].percent,
      swap.srcToken,
      swap.destToken,
      // to withdraw if there is a deposit to prevent leaving WETH dust
      exchangeParams.some(param => param.needWrapNative) &&
        isETHAddress(swap.srcToken),
    );
  }

  protected buildDexCallData(
    swap: OptimalSwap,
    exchangeParam: DexExchangeParam,
    index: number,
    flag: Flag,
  ): string {
    const dontCheckBalanceAfterSwap = flag % 3 === 0;
    const checkDestTokenBalanceAfterSwap = flag % 3 === 2;

    // for cases not 0 or 1
    const insertAmount = flag % 4 !== 0 && flag % 4 !== 1;

    let { exchangeData, specialDexFlag } = exchangeParam;

    exchangeData = this.addTokenAddressToCallData(
      exchangeData,
      swap.srcToken.toLowerCase(),
    );
    exchangeData = this.addTokenAddressToCallData(
      exchangeData,
      swap.destToken.toLowerCase(),
    );

    let tokenBalanceCheckPos = 0;
    if (checkDestTokenBalanceAfterSwap && !dontCheckBalanceAfterSwap) {
      const destTokenAddr = isETHAddress(swap.destToken)
        ? this.dexHelper.config.data.wrappedNativeTokenAddress.toLowerCase()
        : swap.destToken.toLowerCase();

      const destTokenAddrIndex = exchangeData
        .replace('0x', '')
        .indexOf(destTokenAddr.replace('0x', ''));
      tokenBalanceCheckPos = (destTokenAddrIndex - 24) / 2;
    }

    let fromAmountPos = 0;
    let toAmountPos = 0;
    if (insertAmount) {
      const fromAmount = ethers.utils.defaultAbiCoder.encode(
        ['uint256'],
        [swap.swapExchanges[0].srcAmount],
      );
      const toAmount = ethers.utils.defaultAbiCoder.encode(
        ['uint256'],
        [swap.swapExchanges[0].destAmount],
      );

      const fromAmountIndex = exchangeData
        .replace('0x', '')
        .indexOf(fromAmount.replace('0x', ''));
      const toAmountIndex = exchangeData
        .replace('0x', '')
        .indexOf(toAmount.replace('0x', ''));

      fromAmountPos = fromAmountIndex / 2;
      toAmountPos = toAmountIndex / 2;
    }

    return this.buildCallData(
      exchangeParam.targetExchange,
      exchangeData,
      fromAmountPos,
      tokenBalanceCheckPos,
      specialDexFlag || SpecialDex.DEFAULT,
      flag,
      toAmountPos,
    );
  }

  public getAddress(): string {
    return this.dexHelper.config.data.executorsAddresses![Executors.THREE];
  }

  public buildByteCode(
    priceRoute: OptimalRate,
    exchangeParams: DexExchangeParam[],
    sender: string,
    maybeWethCallData?: DepositWithdrawReturn,
  ): string {
    const flags = this.buildFlags(
      priceRoute,
      exchangeParams,
      maybeWethCallData,
    );
    const swap = priceRoute.bestRoute[0].swaps[0];

    // as path are executed in parallel, we can sort them in correct order
    // last path should be the one with wrapping to withdraw WETH dust with `1` flag
    const orderedExchangeParams = exchangeParams
      .map((e, index) => ({
        exchangeParam: e,
        // to keep swapExchange in the same order as exchangeParams
        swapExchange: swap.swapExchanges[index],
      }))
      .sort(e => (e.exchangeParam.needWrapNative ? 1 : -1));

    const swapWithOrderedExchanges: OptimalSwap = {
      ...swap,
      swapExchanges: orderedExchangeParams.map(e => e.swapExchange),
    };

    let swapsCalldata = orderedExchangeParams.reduce<string>(
      (acc, ep, index) =>
        hexConcat([
          acc,
          this.buildSingleSwapCallData(
            priceRoute,
            exchangeParams,
            index,
            flags,
            sender,
            maybeWethCallData,
            swapWithOrderedExchanges,
          ),
        ]),
      '0x',
    );

    return solidityPack(
      ['bytes32', 'bytes', 'bytes'],
      [
        hexZeroPad(hexlify(32), 32), // calldata offset
        hexZeroPad(
          hexlify(hexDataLength(swapsCalldata) + BYTES_96_LENGTH), // calldata length  (96 bytes = bytes12(0) + msg.sender)
          32,
        ),
        swapsCalldata, // // calldata
      ],
    );
  }

  private addMetadata(
    callData: string,
    percentage: number,
    srcTokenAddress: Address,
    destTokenAddress: Address,
    needWithdraw: boolean,
  ) {
    const srcTokenAddressLowered = srcTokenAddress.toLowerCase();
    const destTokenAddressLowered = destTokenAddress.toLowerCase();

    // as src and dest token address were added with addTokenAddressToCallData
    // it's safe here to do indexOf without checking if it's present
    const srcTokenAddrIndex = callData
      .replace('0x', '')
      .indexOf(srcTokenAddressLowered.replace('0x', ''));

    const srcTokenPos = hexZeroPad(hexlify(srcTokenAddrIndex / 2), 8);

    const destTokenAddrIndex = callData
      .replace('0x', '')
      .indexOf(destTokenAddressLowered.replace('0x', ''));

    const destTokenPos = hexZeroPad(hexlify(destTokenAddrIndex / 2), 8);

    return solidityPack(
      ['bytes4', 'bytes4', 'bytes8', 'bytes8', 'bytes8', 'bytes'],
      [
        hexZeroPad(hexlify(hexDataLength(callData)), 4), // calldata size
        hexZeroPad(hexlify(needWithdraw ? 1 : 0), 4), // flag
        destTokenPos, // (8) destTokenPos
        srcTokenPos, // (8) srcTokenPos
        hexZeroPad(hexlify(Math.ceil(percentage * 100)), 8), // percentage
        callData, // swap calldata
      ],
    );
  }
}
