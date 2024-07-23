import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { encodeBytes32String, parseEther, parseUnits } from "ethers";
import { ethers } from "hardhat";
import { PRICE_DECIMALS, DumpVS, VaultsFixture, deployAllContractsFixture, dumpVaultState, printVaultState, expectBigNumberEquals, power, VaultMode, nativeTokenAddress } from "./utils";
import { Vault, MockPriceFeed__factory, TokenPot__factory } from "../typechain";

describe("Vaults", () => {
  let vf: VaultsFixture;
  beforeEach(async () => {
    vf = await loadFixture(deployAllContractsFixture);
  });

  const isEmpty = (S: DumpVS) => {
    return S.M_ETH <= 0 || S.M_ETHx <= 0 || S.M_USB_ETH <= 0;
  };

  const mockPrice = async (vault: Vault, price: bigint) => {
    const { Alice } = vf;
    const priceFeed = MockPriceFeed__factory.connect(await vault.priceFeed(), ethers.provider);
    await priceFeed.connect(Alice).mockPrice(price);
  }

  const mockRebaseEthVault = async (percentage: number) => {
    expect(percentage).to.be.gt(0);
    expect(percentage).to.be.lte(10);

    const tokenPot = await vf.wbtcVault.tokenPot();
    const balance = await ethers.provider.getBalance(tokenPot);
    const rebaseAmount = balance * BigInt(percentage) / (100n);
    await vf.Alice.sendTransaction({ to: tokenPot, value: rebaseAmount });
  }

  const log = false;
  const expectCalcMintPair = (deltaAsset: string, S: DumpVS): [bigint, bigint] => {
    const asset = parseEther(deltaAsset);
    const result: [bigint, bigint] = isEmpty(S)
      ? [
          asset * (S.P_ETH) / (power(S.P_ETH_DECIMALS)) * (power(S.AARDecimals)) / (S.AART),
          asset * (S.AART - (power(S.AARDecimals))) / (S.AART),
        ]
      : [asset * (S.M_USB_ETH) / (S.M_ETH), asset * (S.M_ETHx) / (S.M_ETH)];
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcMintUsbAARU = (deltaAsset: string, S: DumpVS) => {
    const asset = parseEther(deltaAsset);
    //@TODO isEmpty
    // if (isEmpty(S)) return BigInt(0);
    //@TODO (M_ETH * P_ETH - Musb-eth) < 0

    const result = asset * (S.P_ETH) / (power(S.P_ETH_DECIMALS));
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcMintXtokenAARS = (deltaAsset: string, S: DumpVS) => {
    const asset = parseEther(deltaAsset);
    let result = BigInt(0);
    //@TODO isEmpty

    //@TODO (M_ETH * P_ETH - Musb-eth) < 0
    if (S.M_ETH * (S.P_ETH) / (power(S.P_ETH_DECIMALS)) <= (S.M_USB_ETH)) result = BigInt(0);
    else
      result = asset
         * (S.P_ETH)
         / (power(S.P_ETH_DECIMALS))
         * (S.M_ETHx) / (S.M_ETH * (S.P_ETH) / (power(S.P_ETH_DECIMALS)) - (S.M_USB_ETH));

    log && console.info("calc:", result);
    return result;
  };
  const subFee = (amount: bigint, S: DumpVS) => amount - (amount * (S.C) / (power(S.settingDecimals)));
  const expectCalcRedeemByPairWithUsb = (deltaUsb: string, S: DumpVS) => {
    const usbAmount = parseEther(deltaUsb);
    const xAmount = usbAmount * (S.M_ETHx) / (S.M_USB_ETH);
    const expectAssetOut = xAmount * (S.M_ETH) / (S.M_ETHx);
    const result = [xAmount, expectAssetOut];
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcRedeemByXtokenAARU = (deltaX: string, S: DumpVS) => {
    const xAmount = parseEther(deltaX);
    const assetOut = xAmount
       * (S.M_ETH * (S.P_ETH) / (power(S.P_ETH_DECIMALS)) - (S.M_USB_ETH)) / (S.M_ETHx * (S.P_ETH) / (power(S.P_ETH_DECIMALS)));
    const result = assetOut;
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcRedeemByUsbAARS = (deltaUsb: string, S: DumpVS) => {
    const usbAmount = parseEther(deltaUsb);
    let result = BigInt(0);
    if (S.AAR < (power(S.AARDecimals))) {
      result = usbAmount * (S.M_ETH) / (S.M_USB_ETH);
    } else {
      result = usbAmount * (power(S.P_ETH_DECIMALS)) / (S.P_ETH);
    }
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcUsbToEthxAmount = async (deltaUsb: bigint, S: DumpVS) => {
    const aar101 = power(S.AARDecimals) * (101n) / (100n);
    let deltaUsdcx = BigInt(0);
    if (S.AAR < (aar101)) {
      deltaUsdcx = deltaUsb * (S.M_ETHx) * (100n) / (S.M_USB_ETH);
    }
    else {
      let now = await time.latest();
      const RateR = await vf.settings.vaultParamValue(await vf.wbtcVault.getAddress(), encodeBytes32String("RateR"));
      const r = RateR * (BigInt(now) - (S.AARBelowSafeLineTime)) / (BigInt(60 * 60));
      deltaUsdcx = deltaUsb * (S.M_ETHx) * (
        power(S.AARDecimals) + (r)
      ) / (power(S.AARDecimals)) / (
        S.M_ETH * (S.P_ETH) / (power(S.P_ETH_DECIMALS)) - (S.M_USB_ETH)
      );
    }

    return deltaUsdcx;
  }

  // mint pair
  const expectMintPair = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, wbtcVault, Alice, wbtc, usb, wbtcx } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);

    let depositAmount = ethers.parseEther(assetAmount);
    let [expectedUsbAmount, expectedEthxAmount] = expectCalcMintPair(assetAmount, S);
    let calcOut = await vaultQuery.calcMintPairs(await wbtcVault.getAddress(), depositAmount);
    
    expectBigNumberEquals(expectedUsbAmount, calcOut[1]);
    expectBigNumberEquals(expectedEthxAmount, calcOut[2]);
    
    await expect(wbtc.connect(Alice).mint(Alice.address, depositAmount)).not.to.be.reverted;
    await expect(wbtc.connect(Alice).approve(await wbtcVault.getAddress(), depositAmount)).not.to.be.reverted;
    await expect(wbtcVault.connect(Alice).mintPairs(depositAmount, { value: depositAmount })).to.be.rejectedWith("msg.value should be 0");
    const mint = wbtcVault.connect(Alice).mintPairs(depositAmount);
  
    await expect(mint)
      .to.changeTokenBalance(wbtc, Alice, depositAmount * (-1n));
    // await expect(mint)
    //   .to.changeTokenBalance(wbtc, await wbtcVault.tokenPot(), depositAmount);
    await expect(mint)
      .to.changeTokenBalance(usb, Alice, expectedUsbAmount);
    await expect(mint)
      .to.changeTokenBalance(wbtcx, Alice, expectedEthxAmount);
    await expect(mint)
      .to.emit(wbtcVault, "UsbMinted")
      .withArgs(Alice.address, depositAmount, expectedUsbAmount, anyValue, S.P_ETH, PRICE_DECIMALS)
      .to.emit(wbtcVault, "MarginTokenMinted")
      .withArgs(Alice.address, depositAmount, expectedEthxAmount, S.P_ETH, PRICE_DECIMALS);
  };

  // mint usb
  const expectMintUsbAARU = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, wbtcVault, Alice, usb, wbtc } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    let depositAmount = ethers.parseEther(assetAmount);
    expect(S.mode).to.equal(3, "Not support mint usb aaru");
    const expectedUsbAmount = expectCalcMintUsbAARU(assetAmount, S);
    const calcOut = await vaultQuery.calcMintUsbAboveAARU(await wbtcVault.getAddress(), depositAmount);
    expectBigNumberEquals(expectedUsbAmount, calcOut[1]);
    
    await expect(wbtc.connect(Alice).mint(Alice.address, depositAmount)).not.to.be.reverted;
    await expect(wbtc.connect(Alice).approve(await wbtcVault.getAddress(), depositAmount)).not.to.be.reverted;
    await expect(wbtcVault.connect(Alice).mintUsbAboveAARU(depositAmount, { value: depositAmount })).to.be.rejectedWith("msg.value should be 0");
    const tx = wbtcVault.connect(Alice).mintUsbAboveAARU(depositAmount);
    await expect(tx)
      .to.changeTokenBalance(wbtc, Alice, depositAmount * (-1n));
    await expect(tx)
      .to.changeTokenBalance(wbtc, await wbtcVault.tokenPot(), depositAmount);
    await expect(tx)
      .to.changeTokenBalance(usb, Alice, expectedUsbAmount);
    await expect(tx)
      .to.emit(wbtcVault, "UsbMinted")
      .withArgs(Alice.address, depositAmount, expectedUsbAmount, anyValue, S.P_ETH, PRICE_DECIMALS);
  };

  // mint xtoken
  const expectMintXTokenAARS = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, wbtcVault, Alice, wbtcx, wbtc } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    let depositAmount = ethers.parseEther(assetAmount);
    expect(S.mode).to.equal(2, "Not support mint xtoken aaru");
    const expectedXtokenAmount = expectCalcMintXtokenAARS(assetAmount, S);
    const calcOut = await vaultQuery.calcMintMarginTokensBelowAARS(await wbtcVault.getAddress(), depositAmount);
    expectBigNumberEquals(expectedXtokenAmount, calcOut[1]);

    await expect(wbtc.connect(Alice).mint(Alice.address, depositAmount)).not.to.be.reverted;
    await expect(wbtc.connect(Alice).approve(await wbtcVault.getAddress(), depositAmount)).not.to.be.reverted;
    await expect(wbtcVault.connect(Alice).mintMarginTokensBelowAARS(depositAmount, { value: depositAmount })).to.be.rejectedWith("msg.value should be 0");
    const tx = wbtcVault.connect(Alice).mintMarginTokensBelowAARS(depositAmount);
    await expect(tx)
      .to.changeTokenBalance(wbtc, Alice, depositAmount * (-1n));
    await expect(tx)
      .to.changeTokenBalance(wbtc, await wbtcVault.tokenPot(), depositAmount);
    await expect(tx)
      .to.changeTokenBalance(wbtcx, Alice, expectedXtokenAmount);
    await expect(tx)
      .to.emit(wbtcVault, "MarginTokenMinted")
      .withArgs(Alice.address, depositAmount, expectedXtokenAmount, S.P_ETH, PRICE_DECIMALS);
  };

  // redeem ByPairWithUsb
  const expectRedeemByPairWithUsb = async (usbAmount: string, price: bigint) => {
    const { vaultQuery, wbtcVault, Alice, usb, wbtcx, wbtc } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    const usbInput = parseEther(usbAmount);
    const xInput = await vaultQuery.calcPairdMarginTokenAmount(await wbtcVault.getAddress(), usbInput);
    const [, assetOut] = await vaultQuery.calcPairedRedeemAssetAmount(await wbtcVault.getAddress(), xInput);
    const [expectXInput, expectAssetOut] = expectCalcRedeemByPairWithUsb(usbAmount, S);
    expectBigNumberEquals(xInput, expectXInput);
    expectBigNumberEquals(assetOut, expectAssetOut);
    const shouldAssetOut = subFee(assetOut, S);
    await wbtcx.connect(Alice).approve(await wbtcVault.getAddress(), xInput);
    await usb.connect(Alice).approve(await wbtcVault.getAddress(), usbInput);
    
    const tx = wbtcVault.connect(Alice).redeemByPairsWithExpectedUsbAmount(usbInput);
    await expect(tx)
      .to.changeTokenBalances(wbtc, [Alice], [shouldAssetOut]);
    await expect(tx)
      .to.changeTokenBalances(usb, [Alice], [usbInput * (-1n)]);
    await expect(tx)
      .to.changeTokenBalances(wbtcx, [Alice], [xInput * (-1n)]);
  };

  // redeem By usb
  const expectRedeemByUsbAARS = async (usbAmount: string, price: bigint) => {
    const { vaultQuery, wbtcVault, Alice, usb, wbtc } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    expect(S.mode).to.equal(2, "Not support redeem by usb aars");
    const usbInput = parseEther(usbAmount);
    const [, assetOut] = await vaultQuery.calcRedeemByUsbBelowAARS(await wbtcVault.getAddress(), usbInput);
    const expectAssetOut = expectCalcRedeemByUsbAARS(usbAmount, S);
    expectBigNumberEquals(assetOut, expectAssetOut);
    const shouldAssetOut = subFee(assetOut, S);
    await usb.connect(Alice).approve(await wbtcVault.getAddress(), usbInput);
    
    const tx = wbtcVault.connect(Alice).redeemByUsbBelowAARS(usbInput);
    await expect(tx)
      .to.changeTokenBalances(wbtc, [Alice], [shouldAssetOut]);
    await expect(tx)
      .to.changeTokenBalances(usb, [Alice], [usbInput * (-1n)]);
  };

  // redeem By xtoken
  const expectRedeemByXtokenAARU = async (xAmount: string, price: bigint) => {
    const { vaultQuery, wbtcVault, Alice, wbtcx, wbtc } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    expect(S.mode).to.equal(3, "Not support redeem by Xtoken aaru");
    const xInput = parseEther(xAmount);
    const [, assetOut] = await vaultQuery.calcRedeemByMarginTokenAboveAARU(await wbtcVault.getAddress(), xInput);
    const expectAssetOut = expectCalcRedeemByXtokenAARU(xAmount, S);
    expectBigNumberEquals(assetOut, expectAssetOut);
    const shouldAssetOut = subFee(assetOut, S);
    await wbtcx.connect(Alice).approve(await wbtcVault.getAddress(), xInput);
    
    const tx = wbtcVault.connect(Alice).redeemByMarginTokenAboveAARU(xInput);
    await expect(tx)
      .to.changeTokenBalances(wbtc, [Alice], [shouldAssetOut]);
    await expect(tx)
      .to.changeTokenBalances(wbtcx, [Alice], [xInput * (-1n)]);
  };

  const expectUsbToEthxSuspended = async (deltaUsbAmount: string, price: bigint) => {
    const { settings, vaultQuery, wbtcVault, Alice, usb } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    expect([VaultMode.AdjustmentAboveAARU, VaultMode.AdjustmentBelowAARS]).to.be.includes(Number(S.mode));

    const deltaUsb = parseUnits(deltaUsbAmount, await usb.decimals());
    await expect(vaultQuery.connect(Alice).calcUsbToMarginTokens(await wbtcVault.getAddress(), await settings.getAddress(), deltaUsb)).to.be.revertedWith("Conditional Discount Purchase suspended");
    await expect(wbtcVault.connect(Alice).usbToMarginTokens(deltaUsb)).to.be.revertedWith("Conditional Discount Purchase suspended");
  };


  const expectUsbToEthx = async (deltaUsbAmount: string, price: bigint) => {
    const { settings, vaultQuery, wbtcVault, Alice, usb } = vf;
    await mockPrice(wbtcVault, price);
    const S = await dumpVaultState(wbtcVault, vaultQuery);
    // expect(S.AAR).to.be < (S.AARS);
    expect([VaultMode.AdjustmentAboveAARU, VaultMode.AdjustmentBelowAARS]).to.be.includes(Number(S.mode));

    const deltaUsb = parseUnits(deltaUsbAmount, await usb.decimals());
    const expectedEthxAmount = await expectCalcUsbToEthxAmount(deltaUsb, S);
    const [, deltaEthx] = await vaultQuery.calcUsbToMarginTokens(await wbtcVault.getAddress(), await settings.getAddress(), deltaUsb);
    expectBigNumberEquals(expectedEthxAmount, deltaEthx);
    
    const tx = wbtcVault.connect(Alice).usbToMarginTokens(deltaUsb);
    await expect(tx)
      // .to.changeTokenBalance(wbtcx, Alice, deltaEthx)
      .to.changeTokenBalance(usb, Alice, deltaUsb * (-1n));
    await expect(tx)
      .to.emit(wbtcVault, "UsbToMarginTokens").withArgs(Alice.address, deltaUsb, anyValue, S.P_ETH, PRICE_DECIMALS);
  };

  it("First mint work", async () => {
    await expectMintPair("3", BigInt(2300) * (power(PRICE_DECIMALS)));
  });
  
  it("All Mints work", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.wbtcVault.getAddress(), encodeBytes32String("Y"), 0);
    console.log(`\nPrice: 2300; initial mint pairs with 3 $WBTC`);
    await expectMintPair("3", BigInt(2300) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nPrice: 1800; AAR < AARS (130%), mint pairs with 1 $WBTC`);
    await expectMintPair("1", BigInt(1800) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    
    console.log(`\nRebase $WBTC by 1% increase`);
    await mockRebaseEthVault(1);
    console.log(`Price: 1800; AAR < AARS (130%), mint $WBTCx with 1 $WBTC`);
    await expectMintXTokenAARS("1", BigInt(1800) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nPrice: 1800; AAR within [130%, 150%], mint pairs with 1 $WBTC`);
    await expectMintPair("1", BigInt(1800) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nRebase $WBTC by 1% increase`);
    await mockRebaseEthVault(1);
    console.log(`Price: 2200; AAR > 150%, mint $WBTCx with 1 $WBTC`);
    await expectMintXTokenAARS("1", BigInt(2200) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nRebase $WBTC by 1% increase`);
    await mockRebaseEthVault(1);
    console.log(`Price: 2200; AAR > 150%, mint $USB with 1 $WBTC`);
    await expectMintUsbAARU("1", BigInt(2200) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nRebase $WBTC by 1% increase`);
    await mockRebaseEthVault(1);
    console.log(`\nPrice: 1700; AAR < 150%, mint pairs with 1 $WBTC`);
    await expectMintPair("1", BigInt(1700) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nPrice: 1100; AAR (95%) < AARS (130%), mint pairs to update vault state to adjustment mode`);
    await expectMintPair("1", BigInt(1100) * (power(PRICE_DECIMALS)));
    expect(await vf.wbtcVault.AARBelowSafeLineTime()).to.greaterThan(BigInt(0));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nPrice: 1100; AAR (95%) < AARS (130%), conditional discount purchase suspended`);
    // fast forward by 10 minutes
    await time.increase(10 * 60);
    await expectUsbToEthxSuspended("50", BigInt(1100) * (power(PRICE_DECIMALS)));

    console.log(`\nPrice: 1100; AAR (95%) < 101%, 30 minutes later, swap $USB to $WBTCx`);
    await time.increase(30 * 10 * 60);
    await expectUsbToEthx("1000", BigInt(1100) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    console.log(`\nPrice: 1100; AAR (103%) > 101%, swap $USB to $WBTCx`);
    await expectUsbToEthx("1000", BigInt(1100) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    /**
     $WBTC Pool:
      P_WBTC: 1100.0
      M_WBTC: 10.0
      M_USB: 9949.999999999999999997
      M_USB_WBTC: 9949.999999999999999997
      M_WBTCx: 702.410589340633197028
      AAR: 110.552764%
      APY: 0.0
      Mode: AdjustmentBelowAARS
     */
    console.log(`\nPrice: 2100; AAR (211%) > 200%, mint pairs with 0.1 $WBTC, Pty Pool Sell High should be triggered`);
    await expectMintPair("0.1", BigInt(2100) * (power(PRICE_DECIMALS)));
    console.log(`WBTC Vault asset balance: ${ethers.formatUnits(await vf.wbtcVault.assetBalance())} $WBTC`);
    console.log(`WBTC Vault $WBTC balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.getAddress()))} $WBTC`);
    console.log(`WBTC Vault token pot $WBTC balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.tokenPot()))} $WBTC`);
    const ptyPoolSellHighMinAssetAmount = await vf.settings.vaultParamValue(await vf.wbtcVault.getAddress(), encodeBytes32String("PtyPoolMinAssetAmount"));
    console.log(`WBTC Vault PtyPoolSellHigh minimal balance: ${ethers.formatUnits(ptyPoolSellHighMinAssetAmount, await vf.settings.decimals())} $WBTC`);

    await expect(vf.wbtc.connect(vf.Alice).mint(vf.Alice.address, ethers.parseUnits("1000000", 18))).not.to.be.reverted;
    await expect(vf.wbtc.connect(vf.Alice).approve(await vf.wbtcVault.getAddress(), ethers.parseUnits("1000000", 18))).not.to.be.reverted;
    await expect(vf.wbtc.connect(vf.Alice).approve(await vf.wbtcVaultPtyPoolBuyLow.getAddress(), ethers.parseUnits("1000000", 18))).not.to.be.reverted;
    await expect(vf.wbtc.connect(vf.Alice).approve(await vf.wbtcVaultPtyPoolSellHigh.getAddress(), ethers.parseUnits("1000000", 18))).not.to.be.reverted;

    await expect(vf.wbtc.connect(vf.Alice).mint(vf.Bob.address, ethers.parseUnits("1000000", 18))).not.to.be.reverted;
    await expect(vf.wbtc.connect(vf.Bob).approve(await vf.wbtcVault.getAddress(), ethers.parseUnits("1000000", 18))).not.to.be.reverted;
    await expect(vf.wbtc.connect(vf.Bob).approve(await vf.wbtcVaultPtyPoolBuyLow.getAddress(), ethers.parseUnits("1000000", 18))).not.to.be.reverted;
    await expect(vf.wbtc.connect(vf.Bob).approve(await vf.wbtcVaultPtyPoolSellHigh.getAddress(), ethers.parseUnits("1000000", 18))).not.to.be.reverted;

    // Alice stakes 0.1 to PtyPoolSellHigh
    await expect(vf.wbtcVaultPtyPoolSellHigh.connect(vf.Alice).stake(ethers.parseUnits("0.1", 18))).not.to.be.rejected;
    await expectMintPair("0.1", BigInt(2100) * (power(PRICE_DECIMALS)));
    expect(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address)).to.equal(ethers.parseUnits("0.1", 18));
    expect(await vf.wbtcVaultPtyPoolSellHigh.totalStakingBalance()).to.equal(ethers.parseUnits("0.1", 18));
    await expect(vf.wbtcVaultPtyPoolSellHigh.connect(vf.Bob).stake(ethers.parseUnits("0.1", 18))).not.to.be.rejected;

    console.log(`\nBefore PtyPoolSellHigh triggered`);
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    await expectMintPair("0.1", BigInt(2100) * (power(PRICE_DECIMALS)));
    console.log(`\After depositing 0.1 $WBTC and PtyPoolSellHigh triggered`);
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    expect(await vf.wbtc.balanceOf(await vf.wbtcVault.getAddress())).to.equal(0);
    console.log(`WBTC Vault asset balance: ${ethers.formatUnits(await vf.wbtcVault.assetBalance())} $WBTC`);
    console.log(`WBTC Vault $WBTC balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.getAddress()))} $WBTC`);
    console.log(`WBTC Vault token pot $WBTC balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.tokenPot()))} $WBTC`);
    console.log(`WBTC Vault PtyPoolSellHigh Alice staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address))}`);
    console.log(`WBTC Vault PtyPoolSellHigh Alice earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.earnedMatchedToken(vf.Alice.address))} $USB`);
    console.log(`WBTC Vault PtyPoolSellHigh Bob staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Bob.address))}`);
    console.log(`WBTC Vault PtyPoolSellHigh Bob earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.earnedMatchedToken(vf.Bob.address))} $USB`);

    console.log(`\nBob stakes 10 $WBTC to PtyPoolSellHigh`);
    await expect(vf.wbtcVaultPtyPoolSellHigh.connect(vf.Bob).stake(ethers.parseUnits("10"))).not.to.be.rejected;
    console.log(`WBTC Vault PtyPoolSellHigh Alice staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address))}`);
    console.log(`WBTC Vault PtyPoolSellHigh Bob staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Bob.address))}`);

    console.log(`\nBefore PtyPoolSellHigh triggered again`);
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    await expectMintPair("0.1", BigInt(2100) * (power(PRICE_DECIMALS)));
    console.log(`\nAfter depositing 0.1 $WBTC and PtyPoolSellHigh triggered again`);
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    expect(await vf.wbtc.balanceOf(await vf.wbtcVault.getAddress())).to.equal(0);
    console.log(`WBTC Vault asset balance: ${ethers.formatUnits(await vf.wbtcVault.assetBalance())} $WBTC`);
    console.log(`WBTC Vault $WBTC balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.getAddress()))} $WBTC`);
    console.log(`WBTC Vault token pot $WBTC balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.tokenPot()))} $WBTC`);
    console.log(`WBTC Vault PtyPoolSellHigh Alice staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address))}`);
    console.log(`WBTC Vault PtyPoolSellHigh Alice earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.earnedMatchedToken(vf.Alice.address), 18)} $USB`);
    console.log(`WBTC Vault PtyPoolSellHigh Bob staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.userStakingBalance(vf.Bob.address))}`);
    console.log(`WBTC Vault PtyPoolSellHigh Bob earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolSellHigh.earnedMatchedToken(vf.Bob.address), 18)} $USB`);
    await expect(vf.wbtcVaultPtyPoolSellHigh.connect(vf.Bob).exit()).not.to.be.rejected;

    /**
    $WBTC Pool:
      P_WBTC: 2100.0
      M_WBTC: 16.415625
      M_USB: 22981.874999999999999993
      M_USB_WBTC: 22981.874999999999999993
      M_WBTCx: 730.439473434514233254
      AAR: 150.00%
      APY: 0.0
      Mode: Stability
     */
    console.log(`\nPrice: 1700; AAR (121%) < 130%, mint pairs with 0.1 $WBTC, Pty Pool Buy Low should be triggered`);
    await expectMintPair("0.1", BigInt(1700) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    console.log(`WBTC Vault asset balance: ${ethers.formatUnits(await vf.wbtcVault.assetBalance())} $WBTC`);
    console.log(`WBTC Vault token pot balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.tokenPot()))} $WBTC`);
    const ptyPoolBuyLowPtyPoolMinUsbAmount = await vf.settings.vaultParamValue(await vf.wbtcVault.getAddress(), encodeBytes32String("PtyPoolMinUsbAmount"));
    console.log(`WBTC Vault PtyPoolBuyLow minimal $USB amount: ${ethers.formatUnits(ptyPoolBuyLowPtyPoolMinUsbAmount, await vf.settings.decimals())} $WBTC`);

    await expect(vf.usb.connect(vf.Alice).transfer(vf.Bob.address, ethers.parseUnits("1000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.usb.connect(vf.Alice).approve(vf.wbtcVaultPtyPoolBuyLow.getAddress(), ethers.parseUnits("1000000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.usb.connect(vf.Bob).approve(vf.wbtcVaultPtyPoolBuyLow.getAddress(), ethers.parseUnits("1000000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.wbtcVaultPtyPoolBuyLow.connect(vf.Alice).stake(ethers.parseUnits("100", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.wbtcVaultPtyPoolBuyLow.connect(vf.Bob).stake(ethers.parseUnits("100", await vf.usb.decimals()))).not.to.be.rejected;
    await expectMintPair("0.1", BigInt(1700) * (power(PRICE_DECIMALS)));
    console.log(`WBTC Vault PtyPoolBuyLow Alice staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.userStakingBalance(vf.Alice.address), 18)} $USB`);
    console.log(`WBTC Vault PtyPoolBuyLow Alice earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.earnedMatchedToken(vf.Alice.address))} $WBTC`);
    console.log(`WBTC Vault PtyPoolBuyLow Bob staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.userStakingBalance(vf.Bob.address), 18)} $USB`);
    console.log(`WBTC Vault PtyPoolBuyLow Bob earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.earnedMatchedToken(vf.Bob.address))} $WBTC`);

    console.log(`Alice $USB balance: ${ethers.formatUnits(await vf.usb.balanceOf(vf.Alice.address), await vf.usb.decimals())} $USB`);
    console.log(`Bob $USB balance: ${ethers.formatUnits(await vf.usb.balanceOf(vf.Bob.address), await vf.usb.decimals())} $USB`);
    await expect(vf.wbtcVaultPtyPoolBuyLow.connect(vf.Alice).stake(ethers.parseUnits("5000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.wbtcVaultPtyPoolBuyLow.connect(vf.Bob).stake(ethers.parseUnits("10000", await vf.usb.decimals()))).not.to.be.rejected;
    console.log(`\nBefore PtyPoolBuyLow triggered`);
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    await expectMintPair("0.1", BigInt(1700) * (power(PRICE_DECIMALS)));
    console.log(`\nAfter depositing 0.1 $ETH and PtyPoolBuyLow triggered`);
    await printVaultState(vf.wbtcVault, vf.vaultQuery);
    console.log(`WBTC Vault asset balance: ${ethers.formatUnits(await vf.wbtcVault.assetBalance())} $WBTC`);
    console.log(`WBTC Vault token pot balance: ${ethers.formatUnits(await vf.wbtc.balanceOf(await vf.wbtcVault.tokenPot()))} $WBTC`);
    console.log(`WBTC Vault PtyPoolBuyLow Alice staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.userStakingBalance(vf.Alice.address), 18)} $USB`);
    console.log(`WBTC Vault PtyPoolBuyLow Alice earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.earnedMatchedToken(vf.Alice.address))} $WBTC`);
    console.log(`WBTC Vault PtyPoolBuyLow Bob staking balance: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.userStakingBalance(vf.Bob.address), 18)} $USB`);
    console.log(`WBTC Vault PtyPoolBuyLow Bob earned: ${ethers.formatUnits(await vf.wbtcVaultPtyPoolBuyLow.earnedMatchedToken(vf.Bob.address))} $WBTC`);

    await expect(vf.Alice.sendTransaction({ to: await vf.wbtcVault.getAddress(), value: ethers.parseEther('0.1') })).to.be.rejected;
    
    const tokenPot = await TokenPot__factory.connect(await vf.wbtcVault.tokenPot(), vf.Alice);
    await expect(tokenPot.connect(vf.Alice).withdraw(vf.Alice.address, nativeTokenAddress, ethers.parseEther('0.1'))).to.be.revertedWith('TokenPot: caller is not the owner');
    await expect(tokenPot.connect(vf.Alice).withdraw(vf.Alice.address, await vf.wbtc.getAddress(), ethers.parseUnits('0.1', await vf.wbtc.decimals()))).to.be.revertedWith('TokenPot: caller is not the owner');

  });

  it("All Redeem work", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.wbtcVault.getAddress(), encodeBytes32String("Y"), 0);
    await expectMintPair("4", BigInt(2300) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    // to Low
    await expectRedeemByPairWithUsb("1000", BigInt(1800) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    // Already to low
    await expectRedeemByUsbAARS("1000", BigInt(1800) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    await expectRedeemByPairWithUsb("1000", BigInt(1800) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    // expect to High
    await expectRedeemByPairWithUsb("100", BigInt(3200) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    // Already to High
    await expectRedeemByXtokenAARU("0.5", BigInt(3200) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    // expect to stable
    await expectRedeemByPairWithUsb("100", BigInt(1700) * (power(PRICE_DECIMALS)));
    await printVaultState(vf.wbtcVault, vf.vaultQuery);

    // Already to stable
  });
});