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

  const expectCalcFirstMintUsdcx = (deltaUsdcValue: string, S: DumpSVS) => {
    const deltaUsdc = parseUnits(deltaUsdcValue, 18);
    const deltaUsdcx = deltaUsdc
    return deltaUsdcx;
  };

  // first mint $USB fails
  const expectFirstMintUsbFails = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    // expect(S.mode).to.equal(VaultMode.Empty);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    await expect(vaultQuery.connect(Alice).calcMintUsbFromStableVault(await usdcVault.getAddress(), usdcDepositAmount)).to.be.revertedWith("Margin token balance is 0");

    await vaultQuery.calcMintMarginTokensFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    await expect(usdcVault.connect(Alice).mintUsb(usdcDepositAmount)).to.be.revertedWith("Margin token balance is 0");
  };

  // first mint $USDCx
  const expectFirstMintUsdcx = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    const expectedUsdcxAmount = expectCalcFirstMintUsdcx(assetAmount, S);
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

  const expectCalcMintUsb = (deltaUsdc: bigint, S: DumpSVS) => {
    const deltaUsb = deltaUsdc * (S.P_USDC) / (power(S.P_USDC_DECIMALS));
    return deltaUsb;
  };

  const expectCalcMintUSDCx = (deltaUsdc: bigint, S: DumpSVS) => {
    const deltaUsdcx = deltaUsdc * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) * (S.M_USDCx) / (
      S.M_USDC * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) - (S.M_USB_USDC)
    );
    return deltaUsdcx;
  };

  const expectCalcMintUSDCxBelow101 = (deltaUsdc: bigint, S: DumpSVS) => {
    const deltaUsdcx = deltaUsdc * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) * (S.M_USDCx) * (100n) / (S.M_USB_USDC);
    return deltaUsdcx;
  };

  const expectCalcmintPairs = (deltaUsdc: bigint, S: DumpSVS) => {
    // ΔUSB = ΔUSDC * M_USB_USDC / M_USDC
    // ΔUSDCx = ΔUSB * M_USDCx / M_USB_USDC
    const deltaUsb = deltaUsdc * (S.M_USB_USDC) / (S.M_USDC);
    const deltaUsdcx = deltaUsb * (S.M_USDCx) / (S.M_USB_USDC);

    return [deltaUsb, deltaUsdcx];
  };

  const expectCalcRedeemByUsb = (deltaUsb: bigint, S: DumpSVS) => {
    let assetAmount = BigInt(0);
    if (S.AAR < power(S.AARDecimals)) {
      assetAmount = deltaUsb * (S.M_USDC) / (S.M_USB_USDC);
    }
    else {
      assetAmount = deltaUsb * (power(S.P_USDC_DECIMALS)) / (S.P_USDC);
    }
    return expectCalcFees(assetAmount, S);
  };

  const expectCalcRedeemByUsdcx = (deltaUsdcx: bigint, S: DumpSVS) => {
    let assetAmount = BigInt(0);
    if (S.AAR >= (S.AARS)) {
      assetAmount = deltaUsdcx * (S.M_USDC) / (S.M_USDCx) - (
        deltaUsdcx * (S.M_USB_USDC) / (S.M_USDCx * (S.P_USDC) / (power(S.P_USDC_DECIMALS)))
      );
    }
    else {
      // Paired with $USB
      assetAmount = deltaUsdcx * (S.M_USDC) / (S.M_USDCx);
    }
    return expectCalcFees(assetAmount, S);
  };

  const expectCalcPairedUsbAmount = (deltaUsdcx: bigint, S: DumpSVS) => {
    const deltaUsb = deltaUsdcx * (S.M_USB_USDC) / (S.M_USDCx);
    return deltaUsb;
  }

  const expectCalcPairedUsdcxAmount = (deltaUsb: bigint, S: DumpSVS) => {
    const deltaUsdcx = deltaUsb * (S.M_USDCx) / (S.M_USB_USDC);
    return deltaUsdcx;
  }

  const expectCalcUsbToUsdxAmount = async (deltaUsb: bigint, S: DumpSVS) => {
    const aar101 = power(S.AARDecimals) * (101n) / (100n);
    let deltaUsdcx = BigInt(0);
    if (S.AAR < (aar101)) {
      deltaUsdcx = deltaUsb * (S.M_USDCx) * (100n) / (S.M_USB_USDC);
    }
    else {
      let now = await time.latest();
      const RateR = await vf.settings.vaultParamValue(await vf.usdcVault.getAddress(), encodeBytes32String("RateR"));
      const r = RateR * (BigInt(now) - (S.AARBelowSafeLineTime)) / (BigInt(60 * 60));
      deltaUsdcx = deltaUsb * (S.M_USDCx) * (
        power(S.AARDecimals) + (r)
      ) / (power(S.AARDecimals)) / (
        S.M_USDC * (S.P_USDC) / (power(S.P_USDC_DECIMALS)) - (S.M_USB_USDC)
      );
    }

    return deltaUsdcx;
  }

  const expectMintUsb = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usb } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    const expectedUsbAmount = expectCalcMintUsb(usdcDepositAmount, S);
    const calcUsbOut = await vaultQuery.calcMintUsbFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedUsbAmount, calcUsbOut[1]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintUsb(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usb, Alice, calcUsbOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "UsbMinted").withArgs(Alice.address, usdcDepositAmount, calcUsbOut[1], anyValue, S.P_USDC, PRICE_DECIMALS);
  };

  const expectMintUsbFailedBelowAARS = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    // await expect(vaultQuery.connect(Alice).calcMintUsbFromStableVault(await usdcVault.getAddress(), usdcDepositAmount)).to.be.revertedWith("AAR Below AARS");

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    await expect(usdcVault.connect(Alice).mintUsb(usdcDepositAmount)).to.be.revertedWith("AAR Below AARS");
  };

  const expectMintUsdcx = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    const expectedUsdcxAmount = expectCalcMintUSDCx(usdcDepositAmount, S);
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

    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    const expectedUsdcxAmount = expectCalcMintUSDCxBelow101(usdcDepositAmount, S);
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
    const { vaultQuery, usdcVault, Alice, usb, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);

    let usdcDepositAmount = ethers.parseUnits(assetAmount, 18);
    const expectedMintOut = expectCalcmintPairs(usdcDepositAmount, S);
    const calcMintOut = await vaultQuery.calcMintPairsFromStableVault(await usdcVault.getAddress(), usdcDepositAmount);
    expectBigNumberEquals(expectedMintOut[0], calcMintOut[1]);
    expectBigNumberEquals(expectedMintOut[1], calcMintOut[2]);

    await usdc.connect(Alice).mint(Alice.address, usdcDepositAmount);
    await usdc.connect(Alice).approve(await usdcVault.getAddress(), usdcDepositAmount);
    const tx = usdcVault.connect(Alice).mintPairs(usdcDepositAmount);
    await expect(tx)
      .to.changeTokenBalance(usb, Alice, calcMintOut[1]);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, calcMintOut[2]);
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, usdcDepositAmount * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "UsbMinted").withArgs(Alice.address, usdcDepositAmount, calcMintOut[1], anyValue, S.P_USDC, PRICE_DECIMALS)
      .to.emit(usdcVault, "MarginTokenMinted").withArgs(Alice.address, usdcDepositAmount, calcMintOut[2], S.P_USDC, PRICE_DECIMALS);
  };

  // redeem by usb
  const expectRedeemByUsb = async (usbAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usb, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    const deltaUsb = parseUnits(usbAmount, await usb.decimals());
    const [, assetOut, netAssetout, fees] = await vaultQuery.calcRedeemByUsbFromStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsb);

    const expectAssetOut = expectCalcRedeemByUsb(deltaUsb, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);

    const tx = usdcVault.connect(Alice).redeemByUsb(deltaUsb);
    await expect(tx)
      .to.changeTokenBalance(usb, Alice, deltaUsb * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      // .to.changeTokenBalance(usdc, settings.treasury(), fees)
      .to.emit(usdcVault, "AssetRedeemedWithUsb").withArgs(Alice.address, deltaUsb, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);
  };

  const expectRedeemByUsdcxFailsBelowAARS = async (deltaUsdcxAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usdc } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.lt(S.AARS);

    const deltaUsdcx = parseUnits(deltaUsdcxAmount, await usdc.decimals());
    // await expect(vaultQuery.connect(Alice).calcRedeemByMarginTokensFromStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsdcx)).to.be.revertedWith("AAR Below AARS");

    await expect(usdcVault.connect(Alice).redeemByMarginTokens(deltaUsdcx)).to.be.revertedWith("AAR Below AARS");
  };

  const expectRedeemByUsdcx = async (deltaUsdcxAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.gte(S.AARS);

    const deltaUsdcx = parseUnits(deltaUsdcxAmount, await usdc.decimals());
    const [, , netAssetout, fees] = await vaultQuery.calcRedeemByMarginTokensFromStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsdcx);

    const expectAssetOut = expectCalcRedeemByUsdcx(deltaUsdcx, S);
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

  const expectRedeemByUsdcxBelowAARS = async (deltaUsdcxAmount: string, deltaUsbAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usb, usdc, usdcx } = vf;
    await mockPrice(usdcVault, price);
    let S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.lt(S.AARS);

    const deltaUsdcx = parseUnits(deltaUsdcxAmount, await usdc.decimals());
    const expectedPairedUsb = expectCalcPairedUsbAmount(deltaUsdcx, S);
    const pairedUsb = await vaultQuery.calcPairedUsbAmountForStableVault(await usdcVault.getAddress(), deltaUsdcx);
    expectBigNumberEquals(expectedPairedUsb, pairedUsb);
    
    let [, , netAssetout, fees] = await vaultQuery.calcRedeemByPairsAssetAmountForStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsdcx);
    let expectAssetOut = expectCalcRedeemByUsdcx(deltaUsdcx, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);

    let tx = usdcVault.connect(Alice).redeemByPairsWithExpectedMarginTokenAmount(deltaUsdcx);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, deltaUsdcx * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usb, Alice, pairedUsb * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      .to.emit(usdcVault, "AssetRedeemedWithPairs").withArgs(Alice.address, pairedUsb, deltaUsdcx, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);

    S = await dumpStableVaultState(usdcVault, vaultQuery);
    const deltaUsb = parseUnits(deltaUsbAmount, await usb.decimals());
    const expectedPairedUsdcx = expectCalcPairedUsdcxAmount(deltaUsb, S);
    const pairedUsdcx = await vaultQuery.calcPairdMarginTokenAmountForStableVault(await usdcVault.getAddress(), deltaUsb);
    expectBigNumberEquals(expectedPairedUsdcx, pairedUsdcx);
    [, , netAssetout, fees] = await vaultQuery.calcRedeemByPairsAssetAmountForStableVault(await usdcVault.getAddress(), await settings.getAddress(), pairedUsdcx);
    expectAssetOut = expectCalcRedeemByUsdcx(pairedUsdcx, S);
    expectBigNumberEquals(netAssetout, expectAssetOut[0]);
    expectBigNumberEquals(fees, expectAssetOut[1]);
    tx = usdcVault.connect(Alice).redeemByPairsWithExpectedUsbAmount(deltaUsb);
    await expect(tx)
      .to.changeTokenBalance(usdcx, Alice, pairedUsdcx * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usb, Alice, deltaUsb * (-1n));
    await expect(tx)
      .to.changeTokenBalance(usdc, Alice, netAssetout);
    await expect(tx)
      .to.emit(usdcVault, "AssetRedeemedWithPairs").withArgs(Alice.address, deltaUsb, pairedUsdcx, netAssetout, fees, S.P_USDC, PRICE_DECIMALS);
  };

  const expectUsbToUsdx = async (deltaUsbAmount: string, price: bigint) => {
    const { settings, vaultQuery, usdcVault, Alice, usb } = vf;
    await mockPrice(usdcVault, price);
    const S = await dumpStableVaultState(usdcVault, vaultQuery);
    expect(S.AAR).to.be.lt(S.AARS);

    const deltaUsb = parseUnits(deltaUsbAmount, await usb.decimals());
    const expectedUsdxAmount = await expectCalcUsbToUsdxAmount(deltaUsb, S);
    const [, deltaUsdx] = await vaultQuery.calcUsbToMarginTokensForStableVault(await usdcVault.getAddress(), await settings.getAddress(), deltaUsb);
    expectBigNumberEquals(expectedUsdxAmount, deltaUsdx);

    const tx = usdcVault.connect(Alice).usbToMarginTokens(deltaUsb);
    await expect(tx)
      // .to.changeTokenBalance(usdcx, Alice, deltaUsdx)
      .to.changeTokenBalance(usb, Alice, deltaUsb * (-1n));
    await expect(tx)
      .to.emit(usdcVault, "UsbToMarginTokens").withArgs(Alice.address, deltaUsb, anyValue, S.P_USDC, PRICE_DECIMALS);
  };
  
  it("All Mints & Redeem work", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.usdcVault.getAddress(), encodeBytes32String("Y"), 0);

    // first mint $USB fails
    await expectFirstMintUsbFails("1000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));

    // mint $USDCx
    console.log(`\nPrice: 1.01; mint $USDCx with 1000 $USDC`);
    await expectFirstMintUsdcx("1000", BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    // AAR: uint256.max
    
    console.log(`\nPrice: 1.01; mint $USB with 1000 $USDC`);
    await expectMintUsb('1000', BigInt(101) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $USB disabled`);
    await expectMintUsbFailedBelowAARS("1000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.55; AAR (108%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcx("1000", BigInt(55) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (95%) < AARS (110%), mint $USDCx`);
    await expectMintUsdcxBelow101("200", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) < AARS (110%), mint $USB & $USDCx`);
    await expectmintPairs("100", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.32; AAR (101%) > 100n%, redeem by $USB`);
    await expectRedeemByUsb("100", BigInt(32) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < 100n%, redeem by $USB`);
    await expectRedeemByUsb("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx fails`);
    await expectRedeemByUsdcxFailsBelowAARS("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));

    console.log(`\nPrice: 0.36; AAR (114%) > AARS (110%), redeem by $USDCx`);
    await expectRedeemByUsdcx("100", BigInt(36) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.equal(BigInt(0));

    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), redeem by $USDCx with paired $USB`);
    await expectRedeemByUsdcxBelowAARS("200", "100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    expect(await vf.usdcVault.AARBelowSafeLineTime()).to.greaterThan(BigInt(0));
    
    // fast forward by 10 hours
    await time.increase(10 * 60 * 60);
    console.log(`\nPrice: 0.3; AAR (95%) < AARS (110%), 10 hours later, swap $USB to $USDCx`);
    await expectUsbToUsdx("50", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);

    console.log(`\nPrice: 0.3; AAR (102%) > AARS (110%), 10 hours later, swap $USB to $USDCx`);
    await time.increase(10 * 60 * 60);
    await expectUsbToUsdx("100", BigInt(30) * (power(PRICE_DECIMALS)) / (100n));
    await printStableVaultState(vf.usdcVault, vf.vaultQuery);
    
  });
});
