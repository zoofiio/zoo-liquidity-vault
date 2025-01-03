import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { encodeBytes32String, parseUnits } from "ethers";
import { ethers } from "hardhat";
import { PRICE_DECIMALS, DumpSVS, VaultsFixture, deployAllContractsFixture, dumpStableVaultState, printStableVaultState, expectBigNumberEquals, power } from "./utils";
import { StableVault, MockPriceFeed__factory } from "../typechain";

describe("Vaults", () => {
  let vf: VaultsFixture;
  beforeEach(async () => {
    vf = await loadFixture(deployAllContractsFixture);
  });

  const mockPrice = async (vault: StableVault, price: bigint) => {
    const { Alice } = vf;
    const priceFeed = MockPriceFeed__factory.connect(await vault.priceFeed(), ethers.provider);
    await priceFeed.connect(Alice).mockPrice(price);
  }

  const expectCalcFees = (assetAmount: bigint, S: DumpSVS) => {
    const fees = assetAmount * S.C / power(S.settingDecimals);
    const netAssetAmount = assetAmount - fees;
    const feeToTreasury = fees * S.TreasuryFeeRate / power(S.settingDecimals);
    return [netAssetAmount, feeToTreasury];
  }

  const expectCalcFirstMintUsdcx = async (deltaUsdcValue: string, S: DumpSVS) => {
    let deltaUsdc = parseUnits(deltaUsdcValue, await vf.usdc.decimals());

    const decimalsOffset = 18n - (await vf.usdc.decimals());
    deltaUsdc = deltaUsdc * (power(decimalsOffset));

    const deltaUsdcx = deltaUsdc
    return deltaUsdcx;
  };

  // first mint $zUSD fails
  const expectFirstMintUsdFails = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    // expect(S.mode).to.equal(VaultMode.Empty);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    await expect(vaultQuery.connect(Alice).calcMintUsdFromStableVault(await usdcVault.getAddress(), usdcDepositAmount)).to.be.revertedWith("Margin token balance is 0");

    await vaultQuery.calcMintMarginTokensFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    await expect(usdcVault.connect(Alice).mintUsd(usdcDepositAmount)).to.be.revertedWith("Margin token balance is 0");
  };

  // first mint $USDCx
  const expectFirstMintUsdcx = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    const expectedUsdcxAmount = await expectCalcFirstMintUsdcx(assetAmount, S);
    const calcUsdcxOut = await vaultQuery.calcMintMarginTokensFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedUsdcxAmount, calcUsdcxOut[1]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintMarginTokens(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, calcUsdcxOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "MarginTokenMinted")
      .withArgs(Alice.address, usdcDepositAmount, calcUsdcxOut[1], S.P_USDC, PRICE_DECIMALS);
  };

  const expectCalcMintUsd = async(deltaUsdc: bigint, S: DumpSVS) => {
    const decimalsOffset = 18n - (await vf.usdc.decimals());
    deltaUsdc = deltaUsdc * power(decimalsOffset);

    const deltaUsd = deltaUsdc * (S.P_USDC) / (power(S.P_USDC_DECIMALS));
    return deltaUsd;
  };

  const expectCalcMintUSDCx = async(deltaUsdc: bigint, S: DumpSVS) => {
    const decimalsOffset = 18n - (await vf.usdc.decimals());
    deltaUsdc = deltaUsdc * power(decimalsOffset);
    const M_USDC = S.M_USDC * power(decimalsOffset);

    const deltaUsdcx = deltaUsdc * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) * (S.M_USDCx) / (
      M_USDC * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) - (S.M_USD_USDC)
    );
    return deltaUsdcx;
  };

  const expectCalcMintUSDCxBelow101 = async(deltaUsdc: bigint, S: DumpSVS) => {
    const decimalsOffset = 18n - (await vf.usdc.decimals());
    deltaUsdc = deltaUsdc * power(decimalsOffset);

    const deltaUsdcx = deltaUsdc * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) * (S.M_USDCx) * (100n) / (S.M_USD_USDC);
    return deltaUsdcx;
  };

  const expectCalcmintPairs = (deltaUsdc: bigint, S: DumpSVS) => {
    // ΔUSD = ΔUSDC * M_USD_USDC / M_USDC
    // ΔUSDCx = ΔUSD * M_USDCx / M_USD_USDC
    const deltaUsd = deltaUsdc * (S.M_USD_USDC) / (S.M_USDC);
    const deltaUsdcx = deltaUsd * (S.M_USDCx) / (S.M_USD_USDC);

    return [deltaUsd, deltaUsdcx];
  };

  const expectCalcRedeemByUsd = async (deltaUsd: bigint, S: DumpSVS) => {
    let assetAmount = BigInt(0);
    if (S.AAR < power(S.AARDecimals)) {
      assetAmount = deltaUsd * (S.M_USDC) / (S.M_USD_USDC);
    }
    else {
      assetAmount = deltaUsd * (power(S.P_USDC_DECIMALS)) / (S.P_USDC);

      const decimalsOffset = 18n - (await vf.usdc.decimals());
      assetAmount = assetAmount / power(decimalsOffset);
    }
    return expectCalcFees(assetAmount, S);
  };

  const expectCalcRedeemByUsdcx = async(deltaUsdcx: bigint, S: DumpSVS) => {
    let assetAmount = BigInt(0);

    const decimalsOffset = 18n - (await vf.usdc.decimals());
    const M_USDC = S.M_USDC * power(decimalsOffset);

    if (S.AAR >= (S.AARS)) {
      assetAmount = deltaUsdcx * (M_USDC) / (S.M_USDCx) - (
        deltaUsdcx * (S.M_USD_USDC) / (S.M_USDCx * (S.P_USDC) / (power(S.P_USDC_DECIMALS)))
      );
    }
    else {
      // Paired with $zUSD
      assetAmount = deltaUsdcx * (M_USDC) / (S.M_USDCx);
    }
    assetAmount = assetAmount / power(decimalsOffset);

    return expectCalcFees(assetAmount, S);
  };

  const expectcalcPairedUsdAmount = (deltaUsdcx: bigint, S: DumpSVS) => {
    const deltaUsd = deltaUsdcx * (S.M_USD_USDC) / (S.M_USDCx);
    return deltaUsd;
  }

  const expectCalcPairedUsdcxAmount = (deltaUsd: bigint, S: DumpSVS) => {
    const deltaUsdcx = deltaUsd * (S.M_USDCx) / (S.M_USD_USDC);
    return deltaUsdcx;
  }

  const expectCalcUsdToUsdxAmount = async (deltaUsd: bigint, S: DumpSVS) => {
    const aar101 = power(S.AARDecimals) * (101n) / (100n);
    let deltaUsdcx = BigInt(0);

    const decimalsOffset = 18n - (await vf.usdc.decimals());
    const M_USDC = S.M_USDC * power(decimalsOffset);

    if (S.AAR < (aar101)) {
      deltaUsdcx = deltaUsd * (S.M_USDCx) * (100n) / (S.M_USD_USDC);
    }
    else {
      let now = await time.latest();
      const RateR = await vf.settings.vaultParamValue(await vf.usdcVault.getAddress(), encodeBytes32String("RateR"));
      const r = RateR * (BigInt(now) - (S.AARBelowSafeLineTime)) / (BigInt(60 * 60));
      deltaUsdcx = deltaUsd * (S.M_USDCx) * (
        power(S.AARDecimals) + (r)
      ) / (power(S.AARDecimals)) / (
        M_USDC * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) - (S.M_USD_USDC)
      );
    }

    return deltaUsdcx;
  }

  const expectMintUsd = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usd } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    const expectedUsdAmount = await expectCalcMintUsd(usdcDepositAmount, S);
    const calcUsdOut = await vaultQuery.calcMintUsdFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedUsdAmount, calcUsdOut[1]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintUsd(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usd, Alice, calcUsdOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "UsdMinted").withArgs(Alice.address, usdcDepositAmount, calcUsdOut[1], anyValue, S.P_USDC, PRICE_DECIMALS);
  };

  const expectMintUsdFailedBelowAARS = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    // await expect(vaultQuery.connect(Alice).calcMintUsdFromStableVault(await usdcVault.getAddress(), usdcDepositAmount)).to.be.revertedWith("AAR Below AARS");

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    await expect(usdcVault.connect(Alice).mintUsd(usdcDepositAmount)).to.be.revertedWith("AAR Below AARS");
  };

  const expectMintUsdcx = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    const expectedUsdcxAmount = await expectCalcMintUSDCx(usdcDepositAmount, S);
    const calcUsdcxOut = await vaultQuery.calcMintMarginTokensFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedUsdcxAmount, calcUsdcxOut[1]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintMarginTokens(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, calcUsdcxOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "MarginTokenMinted").withArgs(Alice.address, usdcDepositAmount, calcUsdcxOut[1], S.P_USDC, PRICE_DECIMALS);
  };

  const expectMintUsdcxBelow101 = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    const expectedUsdcxAmount = await expectCalcMintUSDCxBelow101(usdcDepositAmount, S);
    const calcUsdcxOut = await vaultQuery.calcMintMarginTokensFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedUsdcxAmount, calcUsdcxOut[1]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintMarginTokens(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, calcUsdcxOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "MarginTokenMinted").withArgs(Alice.address, usdcDepositAmount, calcUsdcxOut[1], S.P_USDC, PRICE_DECIMALS);
  };

  const expectmintPairs = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usd, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, await vf.usdc.decimals());
    const expectedMintOut = expectCalcmintPairs(usdcDepositAmount, S);
    const calcMintOut = await vaultQuery.calcMintPairsFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedMintOut[0], calcMintOut[1]);
    expectBigNumberEquals(expectedMintOut[1], calcMintOut[2]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintPairs(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usd, Alice, calcMintOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, calcMintOut[2]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "UsdMinted").withArgs(Alice.address, usdcDepositAmount, calcMintOut[1], anyValue, S.P_USDC, PRICE_DECIMALS)
      .to.emit(usdcVault, "MarginTokenMinted").withArgs(Alice.address, usdcDepositAmount, calcMintOut[2], S.P_USDC, PRICE_DECIMALS);
  };

  // redeem by Usd
  const expectRedeemByUsd = async (usdAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usd, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    const deltaUsd = parseUnits(usdAmount, await usd.decimals());
    const [, assetOut, netAssetout, fees] = await vaultQuery.calcRedeemByUsdFromStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsd);

    const expectAssetOut = await expectCalcRedeemByUsd(deltaUsd, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);

    const tx = usdcVault.connect(Alice).redeemByUsd(deltaUsd);
    await expect(tx)
      .to.changeTokenBalance(usd, Alice, deltaUsd * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      // .to.changeTokenBalance(usdc, settings.treasury(), fees)
      .to.emit(usdcVault, "AssetRedeemedWithUsd").withArgs(Alice.address, deltaUsd, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);
  };

  const expectRedeemByUsdcxFailsBelowAARS = async (deltaUsdcxAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.lt(S.AARS);

    const deltaUsdcx = parseUnits(deltaUsdcxAmount, await usdcx.decimals());
    // await expect(vaultQuery.connect(Alice).calcRedeemByMarginTokensFromStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsdcx)).to.be.revertedWith("AAR Below AARS");

    await expect(usdcVault.connect(Alice).redeemByMarginTokens(deltaUsdcx)).to.be.revertedWith("AAR Below AARS");
  };

  const expectRedeemByUsdcx = async (deltaUsdcxAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.gte(S.AARS);

    const deltaUsdcx = parseUnits(deltaUsdcxAmount, await usdcx.decimals());
    const [, , netAssetout, fees] = await vaultQuery.calcRedeemByMarginTokensFromStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsdcx);

    const expectAssetOut = await expectCalcRedeemByUsdcx(deltaUsdcx, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);

    const tx = usdcVault.connect(Alice).redeemByMarginTokens(deltaUsdcx);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, deltaUsdcx * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      .to.emit(usdcVault, "AssetRedeemedWithMarginTokens").withArgs(Alice.address, deltaUsdcx, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);
  };

  const expectRedeemByUsdcxBelowAARS = async (deltaUsdcxAmount: string, deltaUsdAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usd, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    let S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.lt(S.AARS);

    const deltaUsdcx = parseUnits(deltaUsdcxAmount, await usdcx.decimals());
    const expectedPairedUsd = expectcalcPairedUsdAmount(deltaUsdcx, S);
    const pairedUsd = await vaultQuery.calcPairedUsdAmountForStableVault(await usdcVault.getAddress(), deltaUsdcx);
    expectBigNumberEquals(expectedPairedUsd, pairedUsd);
    
    let [, , netAssetout, fees] = await vaultQuery.calcRedeemByPairsAssetAmountForStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsdcx);
    let expectAssetOut = await expectCalcRedeemByUsdcx(deltaUsdcx, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);

    let tx = usdcVault.connect(Alice).redeemByPairsWithExpectedMarginTokenAmount(deltaUsdcx);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, deltaUsdcx * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usd, Alice, pairedUsd * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      .to.emit(usdcVault, "AssetRedeemedWithPairs").withArgs(Alice.address, pairedUsd, deltaUsdcx, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);

    S = await dumpStableVaultState(usdcVault, vaultQuery);
    const deltaUsd = parseUnits(deltaUsdAmount, await usd.decimals());
    const expectedPairedUsdcx = expectCalcPairedUsdcxAmount(deltaUsd, S);
    const pairedUsdcx = await vaultQuery.calcPairdMarginTokenAmountForStableVault(await usdcVault.getAddress(), deltaUsd);
    expectBigNumberEquals(expectedPairedUsdcx, pairedUsdcx);
    [, , netAssetout, fees] = await vaultQuery.calcRedeemByPairsAssetAmountForStableVault(await usdcVault.getAddress(), await settings.getAddress(), pairedUsdcx);
    expectAssetOut = await expectCalcRedeemByUsdcx(pairedUsdcx, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);
    tx = usdcVault.connect(Alice).redeemByPairsWithExpectedUsdAmount(deltaUsd);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, pairedUsdcx * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usd, Alice, deltaUsd * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      .to.emit(usdcVault, "AssetRedeemedWithPairs").withArgs(Alice.address, deltaUsd, pairedUsdcx, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);
  };

  const expectUsdToUsdx = async (deltaUsdAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usd } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.lt(S.AARS);

    const deltaUsd = parseUnits(deltaUsdAmount, await usd.decimals());
    const expectedUsdxAmount = await expectCalcUsdToUsdxAmount(deltaUsd, S);
    const [, deltaUsdx] = await vaultQuery.calcUsdToMarginTokensForStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsd);
    expectBigNumberEquals(expectedUsdxAmount, deltaUsdx);

    const tx = usdcVault.connect(Alice).usdToMarginTokens(deltaUsd);
    await expect(tx)
      // .to.changeTokenBalance(usdcx, Alice, deltaUsdx)
      .to.changeTokenBalance(usd, Alice, deltaUsd * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "UsdToMarginTokens").withArgs(Alice.address, deltaUsd, anyValue, S.P_USDC, PRICE_DECIMALS);
  };
  
  it("All Mints & Redeem work", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.usdcVault.getAddress(), encodeBytes32String("Y"), 0);

    // first mint $zUSD fails
    await expectFirstMintUsdFails("1000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));

    // mint $USDCx
    console.log(`\nPrice: 1.01; mint $USDCx with 1000 $USDC`);
    await expectFirstMintUsdcx("1000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    // AAR: uint256.max
    
    console.log(`\nPrice: 1.01; mint $zUSD with 1000 $USDC`);
    await expectMintUsd('1000', BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $zUSD disabled`);
    await expectMintUsdFailedBelowAARS("1000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcx("1000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (95%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcxBelow101("200", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) < AARS (110%), mint $zUSD & $USDCx`);
    await expectmintPairs("100", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) > 100n%, redeem by $zUSD`);
    await expectRedeemByUsd("100", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < 100n%, redeem by $zUSD`);
    await expectRedeemByUsd("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx fails`);
    await expectRedeemByUsdcxFailsBelowAARS("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));

    console.log(`\nPrice: 0.36; AAR (114%) > AARS (110%), redeem by $USDCx`);
    await expectRedeemByUsdcx("100", BigInt(36) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.equal(BigInt(0));

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx with paired $zUSD`);
    await expectRedeemByUsdcxBelowAARS("200", "100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.greaterThan(BigInt(0));
    
    // fast forward by 10 hours
    await time.increase(10 * 60 * 60);
    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), 10 hours later, swap $zUSD to $USDCx`);
    await expectUsdToUsdx("50", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (102%) > AARS (110%), 10 hours later, swap $zUSD to $USDCx`);
    await time.increase(10 * 60 * 60);
    await expectUsdToUsdx("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    
  });

  it("All Mints & Redeem work with huge numbers", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.usdcVault.getAddress(), encodeBytes32String("Y"), 0);

    // first mint $zUSD fails
    await expectFirstMintUsdFails("1000000000000000000000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));

    // mint $USDCx
    console.log(`\nPrice: 1.01; mint $USDCx with 1000000000000000000000 (1000 * 10^18) $USDC`);
    await expectFirstMintUsdcx("1000000000000000000000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    // AAR: uint256.max
    
    console.log(`\nPrice: 1.01; mint $zUSD with 1000000000000000000000 (1000 * 10^18) $USDC`);
    await expectMintUsd('1000000000000000000000', BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $zUSD disabled`);
    await expectMintUsdFailedBelowAARS("1000000000000000000000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcx("1000000000000000000000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (95%) < AARS (110%), mint 200000000000000000000 (200 * 10^18) $USDCx`);
    await expectMintUsdcxBelow101("200000000000000000000", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) < AARS (110%), mint 100000000000000000000 / (10^18) $zUSD & $USDCx`);
    await expectmintPairs("100000000000000000000", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) > 100n%, redeem by $zUSD`);
    await expectRedeemByUsd("100000000000000000000", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < 100n%, redeem by $zUSD`);
    await expectRedeemByUsd("100000000000000000000", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx fails`);
    await expectRedeemByUsdcxFailsBelowAARS("100000000000000000000", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));

    console.log(`\nPrice: 0.36; AAR (114%) > AARS (110%), redeem by $USDCx`);
    await expectRedeemByUsdcx("100000000000000000000", BigInt(36) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.equal(BigInt(0));

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx with paired $zUSD`);
    await expectRedeemByUsdcxBelowAARS("200000000000000000000", "100000000000000000000", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.greaterThan(BigInt(0));
    
    // fast forward by 10 hours
    await time.increase(10 * 60 * 60);
    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), 10 hours later, swap $zUSD to $USDCx`);
    await expectUsdToUsdx("50000000000000000000", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (102%) > AARS (110%), 10 hours later, swap $zUSD to $USDCx`);
    await time.increase(10 * 60 * 60);
    await expectUsdToUsdx("100000000000000000000", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    
  });

  it("All Mints & Redeem with ERC20 assets with decimals other than 18 work", async () => {
    // Update $USDC decimals to 8
    await expect(vf.usdc.connect(vf.Alice).setDecimals(8)).not.to.be.reverted;
    
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.usdcVault.getAddress(), encodeBytes32String("Y"), 0);

    // first mint $zUSD fails
    await expectFirstMintUsdFails("1000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));

    // mint $USDCx
    console.log(`\nPrice: 1.01; mint $USDCx with 1000 $USDC`);
    await expectFirstMintUsdcx("1000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    // AAR: uint256.max
    
    console.log(`\nPrice: 1.01; mint $zUSD with 1000 $USDC`);
    await expectMintUsd('1000', BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $zUSD disabled`);
    await expectMintUsdFailedBelowAARS("1000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcx("1000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (95%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcxBelow101("200", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) < AARS (110%), mint $zUSD & $USDCx`);
    await expectmintPairs("100", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) > 100n%, redeem by $zUSD`);
    await expectRedeemByUsd("100", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < 100n%, redeem by $zUSD`);
    await expectRedeemByUsd("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx fails`);
    await expectRedeemByUsdcxFailsBelowAARS("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));

    console.log(`\nPrice: 0.36; AAR (114%) > AARS (110%), redeem by $USDCx`);
    await expectRedeemByUsdcx("100", BigInt(36) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.equal(BigInt(0));

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx with paired $zUSD`);
    await expectRedeemByUsdcxBelowAARS("200", "100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.greaterThan(BigInt(0));
    
    // fast forward by 10 hours
    await time.increase(10 * 60 * 60);
    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), 10 hours later, swap $zUSD to $USDCx`);
    await expectUsdToUsdx("50", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (102%) > AARS (110%), 10 hours later, swap $zUSD to $USDCx`);
    await time.increase(10 * 60 * 60);
    await expectUsdToUsdx("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    
  });
});
