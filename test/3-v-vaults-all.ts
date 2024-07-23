import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { encodeBytes32String, parseEther, parseUnits } from "ethers";
import { ethers } from "hardhat";
import {
  DumpVS, VaultsFixture, deployAllContractsFixture, dumpVaultState, printVaultState,
  expectBigNumberEquals, power, VaultMode,
  getBoundValidator, getChainlinkOracle, getPythOracle, getMockChainlinkFeed,
  nativeTokenAddress, getBytes32String, getTime
} from "./utils";
import {
  Vault, MockV3Aggregator__factory, ResilientOracle__factory, ResilientOracle, OracleInterface,
  ChainlinkOracle,
  PythOracle
} from "../typechain";

const { provider } = ethers;

const PRICE_DECIMALS = 18n;
const PRICE_BOUND_RATIO_EXP_SCALE = 10n ** 18n;
// Check: https://bscscan.com/address/0x8455EFA4D7Ff63b8BFD96AdD889483Ea7d39B70a#readProxyContract:tokenConfigs('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')
const PRICE_MAX_STALE_PERIOD = 100n; // 100 seconds

describe("Vaults", () => {
  let vf: VaultsFixture;
  let mainOracle: ChainlinkOracle, pivotOracle: PythOracle, fallbackOracle: OracleInterface;
  let resilientOracle: ResilientOracle;

  beforeEach(async () => {
    vf = await loadFixture(deployAllContractsFixture);

    // Update ethVault to use ResilientOracle
    const boundValidator = await getBoundValidator(await vf.protocol.getAddress());
    // https://bscscan.com/address/0x6E332fF0bB52475304494E4AE5063c1051c7d735#readProxyContract('0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB')
    await boundValidator.connect(vf.Alice).setValidateConfigs([{
      asset: nativeTokenAddress,
      upperBoundRatio: PRICE_BOUND_RATIO_EXP_SCALE * 101n / 100n,
      lowerBoundRatio: PRICE_BOUND_RATIO_EXP_SCALE * 99n/ 100n
    }]);

    mainOracle = await getChainlinkOracle(await vf.protocol.getAddress());
    await mainOracle.connect(vf.Alice).setTokenConfigs([
      {
        asset: nativeTokenAddress,
        feed: await (await getMockChainlinkFeed(18n, 0n)).getAddress(),
        maxStalePeriod: PRICE_MAX_STALE_PERIOD,
      },
    ]);

    pivotOracle = await getPythOracle(await vf.protocol.getAddress());
    await pivotOracle.connect(vf.Alice).setTokenConfigs([
      {
        asset: nativeTokenAddress,
        pythId: getBytes32String(1),
        maxStalePeriod: PRICE_MAX_STALE_PERIOD,
      }
    ]);

    fallbackOracle = await getChainlinkOracle(await vf.protocol.getAddress());

    const ResilientOracleFactory = await ethers.getContractFactory("ResilientOracle");
    const ResilientOracle = await ResilientOracleFactory.deploy(await vf.protocol.getAddress(), await boundValidator.getAddress());
    resilientOracle = ResilientOracle__factory.connect(await ResilientOracle.getAddress(), provider);
    await resilientOracle.connect(vf.Alice).setTokenConfigs([
      {
        asset: nativeTokenAddress,
        oracles: [await mainOracle.getAddress(), await pivotOracle.getAddress(), await fallbackOracle.getAddress()],
        enableFlagsForOracles: [true, true, false],
      }
    ]);

    const ResilientPriceFeedFactory = await ethers.getContractFactory("ResilientPriceFeed");
    const ResilientPriceFeed = await ResilientPriceFeedFactory.deploy(nativeTokenAddress, await resilientOracle.getAddress());
    await vf.ethVault.connect(vf.Alice).updatePriceFeed(await ResilientPriceFeed.getAddress());
  });

  const isEmpty = (S: DumpVS) => {
    return S.M_ETH <= 0 || S.M_ETHx <= 0 || S.M_USB_ETH <= 0;
  };

  const mockPrice = async (vault: Vault, price: bigint) => {
    let [, feed, ] = await mainOracle.tokenConfigs(nativeTokenAddress);
    let feedInstance = MockV3Aggregator__factory.connect(feed, provider);
    await expect(feedInstance.connect(vf.Alice).updateAnswer(price * (10n ** PRICE_DECIMALS))).not.to.be.reverted;

    const UnderlyingPythFactory = await ethers.getContractFactory("MockAbsPyth");
    const underlyingPythOracle = UnderlyingPythFactory.attach(await pivotOracle.underlyingPythOracle());
    // Set pivot price to 99.9% of main price, which should be within the bound [99%, 101%]
    await underlyingPythOracle.connect(vf.Alice).updatePriceFeedsHarness([
      {
        id: getBytes32String(1),
        price: { price: price * 999n / 1000n, conf: 10, expo: 0, publishTime: await getTime() },
        emaPrice: { price: 0, conf: 0, expo: 0, publishTime: 0 },
      }
    ]);
  }

  const mockRebaseEthVaultV2 = async (percentage: number) => {
    expect(percentage).to.be.gt(0);
    expect(percentage).to.be.lte(10);

    const tokenPot = await vf.ethVault.tokenPot();
    const balance = await ethers.provider.getBalance(tokenPot);
    const rebaseAmount = balance * BigInt(percentage) / 100n;
    await vf.Alice.sendTransaction({ to: tokenPot, value: rebaseAmount });
  }

  const log = false;
  const expectCalcMintPair = (deltaAsset: string, S: DumpVS): [bigint, bigint] => {
    const asset = parseEther(deltaAsset);
    const result: [bigint, bigint] = isEmpty(S)
      ? [
          asset * S.P_ETH / power(S.P_ETH_DECIMALS) * power(S.AARDecimals) / S.AART,
          asset * (S.AART - power(S.AARDecimals)) / S.AART,
        ]
      : [asset * S.M_USB_ETH / S.M_ETH, asset * S.M_ETHx / S.M_ETH];
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcMintUsbAARU = (deltaAsset: string, S: DumpVS) => {
    const asset = parseEther(deltaAsset);
    //@TODO isEmpty
    // if (isEmpty(S)) return BigInt(0);
    //@TODO (M_ETH * P_ETH - Musb-eth) < 0

    const result = asset * S.P_ETH / power(S.P_ETH_DECIMALS);
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcMintXtokenAARS = (deltaAsset: string, S: DumpVS) => {
    const asset = parseEther(deltaAsset);
    let result = BigInt(0);
    //@TODO isEmpty

    //@TODO (M_ETH * P_ETH - Musb-eth) < 0
    if (S.M_ETH * S.P_ETH / power(S.P_ETH_DECIMALS) <= S.M_USB_ETH) result = BigInt(0);
    else
      result = asset
        * S.P_ETH
        / power(S.P_ETH_DECIMALS)
        * S.M_ETHx
        / (S.M_ETH * S.P_ETH / power(S.P_ETH_DECIMALS) - S.M_USB_ETH);
    log && console.info("calc:", result);
    return result;
  };
  const subFee = (amount: bigint, S: DumpVS) => amount - (amount * S.C / power(S.settingDecimals));
  const expectCalcRedeemByPairWithUsb = (deltaUsb: string, S: DumpVS) => {
    const usbAmount = parseEther(deltaUsb);
    const xAmount = usbAmount * S.M_ETHx / S.M_USB_ETH;
    const expectAssetOut = xAmount * S.M_ETH / S.M_ETHx;
    const result = [xAmount, expectAssetOut];
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcRedeemByXtokenAARU = (deltaX: string, S: DumpVS) => {
    const xAmount = parseEther(deltaX);
    const assetOut = xAmount
      * (S.M_ETH * S.P_ETH / power(S.P_ETH_DECIMALS) - S.M_USB_ETH)
      / (S.M_ETHx * S.P_ETH / power(S.P_ETH_DECIMALS));
    const result = assetOut;
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcRedeemByUsbAARS = (deltaUsb: string, S: DumpVS) => {
    const usbAmount = parseEther(deltaUsb);
    let result = BigInt(0);
    if (S.AAR < power(S.AARDecimals)) {
      result = usbAmount * S.M_ETH / S.M_USB_ETH;
    } else {
      result = usbAmount * power(S.P_ETH_DECIMALS) / S.P_ETH;
    }
    log && console.info("calc:", result);
    return result;
  };

  const expectCalcUsbToEthxAmount = async (deltaUsb: bigint, S: DumpVS) => {
    const aar101 = power(S.AARDecimals) * 101n / 100n;
    let deltaUsdcx = BigInt(0);
    if (S.AAR < aar101) {
      deltaUsdcx = deltaUsb * S.M_ETHx * 100n / S.M_USB_ETH;
    }
    else {
      let now = await time.latest();
      const RateR = await vf.settings.vaultParamValue(await vf.ethVault.getAddress(), encodeBytes32String("RateR"));
      const r = RateR * (BigInt(now) - S.AARBelowSafeLineTime) / BigInt(60 * 60);
      deltaUsdcx = deltaUsb * (S.M_ETHx) * (
        power(S.AARDecimals) + r
      ) / power(S.AARDecimals) / (
        S.M_ETH * (S.P_ETH) / power(S.P_ETH_DECIMALS) - S.M_USB_ETH
      );
    }

    return deltaUsdcx;
  }

  // mint pair
  const expectMintPair = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, ethVault, Alice, usb, ethx } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);

    let ethDepositAmount = ethers.parseEther(assetAmount);
    let [expectedUsbAmount, expectedEthxAmount] = expectCalcMintPair(assetAmount, S);
    let calcOut = await vaultQuery.calcMintPairs(await ethVault.getAddress(), ethDepositAmount);
    
    expectBigNumberEquals(expectedUsbAmount, calcOut[1]);
    expectBigNumberEquals(expectedEthxAmount, calcOut[2]);
    
    await expect(ethVault.connect(Alice).mintPairs(ethDepositAmount, { value: ethDepositAmount / 2n })).to.be.rejected;
    await expect(ethVault.connect(Alice).mintPairs(ethDepositAmount, { value: ethDepositAmount * 2n })).to.be.rejected;
    const mint = ethVault.connect(Alice).mintPairs(ethDepositAmount, { value: ethDepositAmount });
  
    await expect(mint)
      .to.changeTokenBalance(usb, Alice, expectedUsbAmount);
    await expect(mint)
      .to.changeTokenBalance(ethx, Alice, expectedEthxAmount);
    await expect(mint)
      .to.emit(ethVault, "UsbMinted")
      .withArgs(Alice.address, ethDepositAmount, expectedUsbAmount, anyValue, S.P_ETH, PRICE_DECIMALS)
      .to.emit(ethVault, "MarginTokenMinted")
      .withArgs(Alice.address, ethDepositAmount, expectedEthxAmount, S.P_ETH, PRICE_DECIMALS);
  };

  // mint usb
  const expectMintUsbAARU = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, ethVault, Alice, usb } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    let ethDepositAmount = ethers.parseEther(assetAmount);
    expect(S.mode).to.equal(3, "Not support mint usb aaru");
    const expectedUsbAmount = expectCalcMintUsbAARU(assetAmount, S);
    const calcOut = await vaultQuery.calcMintUsbAboveAARU(await ethVault.getAddress(), ethDepositAmount);
    expectBigNumberEquals(expectedUsbAmount, calcOut[1]);
    
    const tx = ethVault.connect(Alice).mintUsbAboveAARU(ethDepositAmount, { value: ethDepositAmount });
    await expect(tx)
      // .to.changeEtherBalances([Alice, ethVault], [ethDepositAmount * (-1), ethDepositAmount])
      .to.changeTokenBalance(usb, Alice, expectedUsbAmount);
    await expect(tx)
      .to.emit(ethVault, "UsbMinted")
      .withArgs(Alice.address, ethDepositAmount, expectedUsbAmount, anyValue, S.P_ETH, PRICE_DECIMALS);
  };

  // mint xtoken
  const expectMintXTokenAARS = async (assetAmount: string, price: bigint) => {
    const { vaultQuery, ethVault, Alice, ethx } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    let ethDepositAmount = ethers.parseEther(assetAmount);
    expect(S.mode).to.equal(2, "Not support mint xtoken aaru");
    const expectedXtokenAmount = expectCalcMintXtokenAARS(assetAmount, S);
    const calcOut = await vaultQuery.calcMintMarginTokensBelowAARS(await ethVault.getAddress(), ethDepositAmount);
    expectBigNumberEquals(expectedXtokenAmount, calcOut[1]);

    const tx = ethVault.connect(Alice).mintMarginTokensBelowAARS(ethDepositAmount, { value: ethDepositAmount });
    await expect(tx)
      // .to.changeEtherBalances([Alice, ethVault], [ethDepositAmount * (-1), ethDepositAmount])
      .to.changeTokenBalance(ethx, Alice, expectedXtokenAmount);
    await expect(tx)
      .to.emit(ethVault, "MarginTokenMinted")
      .withArgs(Alice.address, ethDepositAmount, expectedXtokenAmount, S.P_ETH, PRICE_DECIMALS);
  };

  // redeem ByPairWithUsb
  const expectRedeemByPairWithUsb = async (usbAmount: string, price: bigint) => {
    const { vaultQuery, ethVault, Alice, usb, ethx } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    const usbInput = parseEther(usbAmount);
    const xInput = await vaultQuery.calcPairdMarginTokenAmount(await ethVault.getAddress(), usbInput);
    const [, assetOut] = await vaultQuery.calcPairedRedeemAssetAmount(await ethVault.getAddress(), xInput);
    const [expectXInput, expectAssetOut] = expectCalcRedeemByPairWithUsb(usbAmount, S);
    expectBigNumberEquals(xInput, expectXInput);
    expectBigNumberEquals(assetOut, expectAssetOut);
    const shouldAssetOut = subFee(assetOut, S);
    await ethx.connect(Alice).approve(await ethVault.getAddress(), xInput);
    await usb.connect(Alice).approve(await ethVault.getAddress(), usbInput);
    
    const tx = ethVault.connect(Alice).redeemByPairsWithExpectedUsbAmount(usbInput);
    await expect(tx)
      // .to.changeEtherBalances([Alice, ethVault], [shouldAssetOut, shouldAssetOut * (-1)])
      .to.changeTokenBalances(usb, [Alice], [-usbInput]);
    await expect(tx)
      .to.changeTokenBalances(ethx, [Alice], [-xInput]);
  };

  // redeem By usb
  const expectRedeemByUsbAARS = async (usbAmount: string, price: bigint) => {
    const { vaultQuery, ethVault, Alice, usb } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    expect(S.mode).to.equal(2, "Not support redeem by usb aars");
    const usbInput = parseEther(usbAmount);
    const [, assetOut] = await vaultQuery.calcRedeemByUsbBelowAARS(await ethVault.getAddress(), usbInput);
    const expectAssetOut = expectCalcRedeemByUsbAARS(usbAmount, S);
    expectBigNumberEquals(assetOut, expectAssetOut);
    const shouldAssetOut = subFee(assetOut, S);
    await usb.connect(Alice).approve(await ethVault.getAddress(), usbInput);
    
    await expect(ethVault.connect(Alice).redeemByUsbBelowAARS(usbInput))
      // .to.changeEtherBalances([Alice, ethVault], [shouldAssetOut, -shouldAssetOut])
      .to.changeTokenBalances(usb, [Alice], [-usbInput]);
  };

  // redeem By xtoken
  const expectRedeemByXtokenAARU = async (xAmount: string, price: bigint) => {
    const { vaultQuery, ethVault, Alice, ethx } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    expect(S.mode).to.equal(3, "Not support redeem by Xtoken aaru");
    const xInput = parseEther(xAmount);
    const [, assetOut] = await vaultQuery.calcRedeemByMarginTokenAboveAARU(await ethVault.getAddress(), xInput);
    const expectAssetOut = expectCalcRedeemByXtokenAARU(xAmount, S);
    expectBigNumberEquals(assetOut, expectAssetOut);
    const shouldAssetOut = subFee(assetOut, S);
    await ethx.connect(Alice).approve(await ethVault.getAddress(), xInput);
    
    await expect(ethVault.connect(Alice).redeemByMarginTokenAboveAARU(xInput))
      // .to.changeEtherBalances([Alice, ethVault], [shouldAssetOut, -shouldAssetOut])
      .to.changeTokenBalances(ethx, [Alice], [-xInput]);
  };

  const expectUsbToEthxSuspended = async (deltaUsbAmount: string, price: bigint) => {
    const { settings, vaultQuery, ethVault, Alice, usb } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    expect([VaultMode.AdjustmentAboveAARU, VaultMode.AdjustmentBelowAARS]).to.be.includes(Number(S.mode));

    const deltaUsb = parseUnits(deltaUsbAmount, await usb.decimals());
    await expect(vaultQuery.connect(Alice).calcUsbToMarginTokens(await ethVault.getAddress(), await settings.getAddress(), deltaUsb)).to.be.revertedWith("Conditional Discount Purchase suspended");
    await expect(ethVault.connect(Alice).usbToMarginTokens(deltaUsb)).to.be.revertedWith("Conditional Discount Purchase suspended");
  };

  const expectUsbToEthx = async (deltaUsbAmount: string, price: bigint) => {
    const { settings, vaultQuery, ethVault, Alice, usb } = vf;
    await mockPrice(ethVault, price);
    const S = await dumpVaultState(ethVault, vaultQuery);
    // expect(S.AAR).to.be.lt(S.AARS);
    expect([VaultMode.AdjustmentAboveAARU, VaultMode.AdjustmentBelowAARS]).to.be.includes(Number(S.mode));

    const deltaUsb = parseUnits(deltaUsbAmount, await usb.decimals());
    const expectedEthxAmount = await expectCalcUsbToEthxAmount(deltaUsb, S);
    const [, deltaEthx] = await vaultQuery.calcUsbToMarginTokens(await ethVault.getAddress(), await settings.getAddress(), deltaUsb);
    expectBigNumberEquals(expectedEthxAmount, deltaEthx);
    
    const tx = ethVault.connect(Alice).usbToMarginTokens(deltaUsb);
    await expect(tx)
      // .to.changeTokenBalance(ethx, Alice, deltaEthx)
      .to.changeTokenBalance(usb, Alice, -deltaUsb);
    await expect(tx)
      .to.emit(ethVault, "UsbToMarginTokens").withArgs(Alice.address, deltaUsb, anyValue, S.P_ETH, PRICE_DECIMALS);
  };

  it("First mint work", async () => {
    await expectMintPair("3", 2300n);
  });
  
  it("All Mints work", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.ethVault.getAddress(), encodeBytes32String("Y"), 0);

    console.log(`\nPrice: 2300; initial mint pairs with 3 $ETH`);
    await expectMintPair("3", 2300n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nPrice: 1800; AAR < AARS (130%), mint pairs with 1 $ETH`);
    await expectMintPair("1", 1800n);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    
    console.log(`\nRebase $ETH by 1% increase`);
    await mockRebaseEthVaultV2(1);
    console.log(`Price: 1800; AAR < AARS (130%), mint $ETHx with 1 $ETH`);
    await expectMintXTokenAARS("1", 1800n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nPrice: 1800; AAR within [130%, 150%], mint pairs with 1 $ETH`);
    await expectMintPair("1", 1800n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nRebase $ETH by 1% increase`);
    await mockRebaseEthVaultV2(1);
    console.log(`Price: 2200; AAR > 150%, mint $ETHx with 1 $ETH`);
    await expectMintXTokenAARS("1", 2200n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nRebase $ETH by 1% increase`);
    await mockRebaseEthVaultV2(1);
    console.log(`Price: 2200; AAR > 150%, mint $USB with 1 $ETH`);
    await expectMintUsbAARU("1", 2200n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nRebase $ETH by 1% increase`);
    await mockRebaseEthVaultV2(1);
    console.log(`\nPrice: 1700; AAR < 150%, mint pairs with 1 $ETH`);
    await expectMintPair("1", 1700n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nPrice: 1100; AAR (95%) < AARS (130%), mint pairs to update vault state to adjustment mode`);
    await expectMintPair("1", 1100n);
    expect(await vf.ethVault.AARBelowSafeLineTime()).to.greaterThan(BigInt(0));
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nPrice: 1100; AAR (95%) < AARS (130%), conditional discount purchase suspended`);
    // fast forward by 10 minutes
    await time.increase(10 * 60);
    await expectUsbToEthxSuspended("50", 1100n);

    console.log(`\nPrice: 1100; AAR (95%) < 101%, 30 minutes later, swap $USB to $ETHx`);
    await time.increase(30 * 10 * 60);
    await expectUsbToEthx("1000", 1100n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nPrice: 1100; AAR (103%) > 101%, swap $USB to $ETHx`);
    await expectUsbToEthx("1000", 1100n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    console.log(`\nPrice: 1400; AAR (145%) within [130%, 150%], mint pairs with 1 $ETH`);
    await expectMintPair("1", 1400n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    /**
     $ETH Pool:
      P_ETH: 1400.0
      M_ETH: 11.25311804
      M_USB: 10826.713371965798489281
      M_USB_ETH: 10826.713371965798489281
      M_ETHx: 247.663618259908985434
      AAR: 145.51383%
      APY: 0.0
      Mode: AdjustmentBelowAARS
     */
    console.log(`\nPrice: 2000; AAR (207%) > 200%, mint pairs with 0.1 $ETH, Pty Pool Sell High should be triggered`);
    await expectMintPair("0.1", 2000n);
    console.log(`ETH Vault asset balance: ${ethers.formatEther(await vf.ethVault.assetBalance())} $ETH`);
    console.log(`ETH Vault $ETH balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.getAddress()))} $ETH`);
    console.log(`ETH Vault token pot $ETH balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.tokenPot()))} $ETH`);
    const ptyPoolSellHighMinAssetAmount = await vf.settings.vaultParamValue(await vf.ethVault.getAddress(), encodeBytes32String("PtyPoolMinAssetAmount"));
    console.log(`ETH Vault PtyPoolSellHigh minimal balance: ${ethers.formatUnits(ptyPoolSellHighMinAssetAmount, await vf.settings.decimals())} $ETH`);

    // Alice stakes 0.1 to PtyPoolSellHigh
    await expect(vf.ethVaultPtyPoolSellHigh.connect(vf.Alice).stake(ethers.parseEther("0.1"), { value: ethers.parseUnits("0.1") })).not.to.be.rejected;
    await expectMintPair("0.1", 2000n);
    expect(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address)).to.equal(ethers.parseEther("0.1"));
    expect(await vf.ethVaultPtyPoolSellHigh.totalStakingBalance()).to.equal(ethers.parseEther("0.1"));
    await expect(vf.ethVaultPtyPoolSellHigh.connect(vf.Bob).stake(ethers.parseEther("0.1"), { value: ethers.parseUnits("0.1") })).not.to.be.rejected;
    
    console.log(`\nBefore PtyPoolSellHigh triggered`);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    await expectMintPair("0.1", 2000n);
    console.log(`\After depositing 0.1 $ETH and PtyPoolSellHigh triggered`);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    expect(await ethers.provider.getBalance(await vf.ethVault.getAddress())).to.equal(0);
    console.log(`ETH Vault asset balance: ${ethers.formatEther(await vf.ethVault.assetBalance())} $ETH`);
    console.log(`ETH Vault token pot balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.tokenPot()))} $ETH`);
    console.log(`ETH Vault PtyPoolSellHigh Alice staking balance: ${ethers.formatEther(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address))}`);
    console.log(`ETH Vault PtyPoolSellHigh Alice earned: ${ethers.formatUnits(await vf.ethVaultPtyPoolSellHigh.earnedMatchedToken(vf.Alice.address), 18)} $USB`);
    console.log(`ETH Vault PtyPoolSellHigh Bob staking balance: ${ethers.formatEther(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Bob.address))}`);
    console.log(`ETH Vault PtyPoolSellHigh Bob earned: ${ethers.formatUnits(await vf.ethVaultPtyPoolSellHigh.earnedMatchedToken(vf.Bob.address), 18)} $USB`);

    console.log(`\nBob stakes 10 $ETH to PtyPoolSellHigh`);
    await expect(vf.ethVaultPtyPoolSellHigh.connect(vf.Bob).stake(ethers.parseEther("10"), { value: ethers.parseUnits("1") })).to.be.rejected;
    await expect(vf.ethVaultPtyPoolSellHigh.connect(vf.Bob).stake(ethers.parseEther("10"), { value: ethers.parseUnits("20") })).to.be.rejected;
    await expect(vf.ethVaultPtyPoolSellHigh.connect(vf.Bob).stake(ethers.parseEther("10"), { value: ethers.parseUnits("10") })).not.to.be.rejected;
    console.log(`ETH Vault PtyPoolSellHigh Alice staking balance: ${ethers.formatEther(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address))}`);
    console.log(`ETH Vault PtyPoolSellHigh Bob staking balance: ${ethers.formatEther(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Bob.address))}`);

    console.log(`\nBefore PtyPoolSellHigh triggered again`);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    await expectMintPair("0.1", 2000n);
    console.log(`\nAfter depositing 0.1 $ETH and PtyPoolSellHigh triggered again`);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    expect(await ethers.provider.getBalance(await vf.ethVault.getAddress())).to.equal(0);
    console.log(`ETH Vault asset balance: ${ethers.formatEther(await vf.ethVault.assetBalance())} $ETH`);
    console.log(`ETH Vault $ETH balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.getAddress()))} $ETH`);
    console.log(`ETH Vault token pot $ETH balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.tokenPot()))} $ETH`);
    console.log(`ETH Vault PtyPoolSellHigh Alice staking balance: ${ethers.formatEther(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Alice.address))}`);
    console.log(`ETH Vault PtyPoolSellHigh Alice earned: ${ethers.formatUnits(await vf.ethVaultPtyPoolSellHigh.earnedMatchedToken(vf.Alice.address), 18)} $USB`);
    console.log(`ETH Vault PtyPoolSellHigh Bob staking balance: ${ethers.formatEther(await vf.ethVaultPtyPoolSellHigh.userStakingBalance(vf.Bob.address))}`);
    console.log(`ETH Vault PtyPoolSellHigh Bob earned: ${ethers.formatUnits(await vf.ethVaultPtyPoolSellHigh.earnedMatchedToken(vf.Bob.address), 18)} $USB`);
    await expect(vf.ethVaultPtyPoolSellHigh.connect(vf.Bob).exit()).not.to.be.rejected;

    /**
    $ETH Pool:
      P_ETH: 2000.0
      M_ETH: 18.140683358818174467
      M_USB: 24187.577811757565955874
      M_USB_ETH: 24187.577811757565955874
      M_ETHx: 256.448109548271992075
      AAR: 150.00%
      APY: 0.0
      Mode: Stability
     */
    console.log(`\nPrice: 1600; AAR (120%) < 130%, mint pairs with 0.1 $ETH, Pty Pool Buy Low should be triggered`);
    await expectMintPair("0.1", 1600n);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    console.log(`ETH Vault asset balance: ${ethers.formatEther(await vf.ethVault.assetBalance())} $ETH`);
    console.log(`ETH Vault token pot balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.tokenPot()))} $ETH`);
    const ptyPoolBuyLowPtyPoolMinUsbAmount = await vf.settings.vaultParamValue(await vf.ethVault.getAddress(), encodeBytes32String("PtyPoolMinUsbAmount"));
    console.log(`ETH Vault PtyPoolBuyLow minimal $USB amount: ${ethers.formatUnits(ptyPoolBuyLowPtyPoolMinUsbAmount, await vf.settings.decimals())} $USB`);

    await expect(vf.usb.connect(vf.Alice).transfer(vf.Bob.address, ethers.parseUnits("1000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.usb.connect(vf.Alice).approve(vf.ethVaultPtyPoolBuyLow.getAddress(), ethers.parseUnits("1000000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.usb.connect(vf.Bob).approve(vf.ethVaultPtyPoolBuyLow.getAddress(), ethers.parseUnits("1000000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.ethVaultPtyPoolBuyLow.connect(vf.Alice).stake(ethers.parseUnits("100", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.ethVaultPtyPoolBuyLow.connect(vf.Bob).stake(ethers.parseUnits("100", await vf.usb.decimals()))).not.to.be.rejected;
    await expectMintPair("0.1", 1600n);
    console.log(`ETH Vault PtyPoolBuyLow Alice staking balance: ${ethers.formatUnits(await vf.ethVaultPtyPoolBuyLow.userStakingBalance(vf.Alice.address), 18)} $USB`);
    console.log(`ETH Vault PtyPoolBuyLow Alice earned: ${ethers.formatEther(await vf.ethVaultPtyPoolBuyLow.earnedMatchedToken(vf.Alice.address))} $ETH`);
    console.log(`ETH Vault PtyPoolBuyLow Bob staking balance: ${ethers.formatUnits(await vf.ethVaultPtyPoolBuyLow.userStakingBalance(vf.Bob.address), 18)} $USB`);
    console.log(`ETH Vault PtyPoolBuyLow Bob earned: ${ethers.formatEther(await vf.ethVaultPtyPoolBuyLow.earnedMatchedToken(vf.Bob.address))} $ETH`);

    console.log(`Alice $USB balance: ${ethers.formatUnits(await vf.usb.balanceOf(vf.Alice.address), await vf.usb.decimals())} $USB`);
    console.log(`Bob $USB balance: ${ethers.formatUnits(await vf.usb.balanceOf(vf.Bob.address), await vf.usb.decimals())} $USB`);
    await expect(vf.ethVaultPtyPoolBuyLow.connect(vf.Alice).stake(ethers.parseUnits("10000", await vf.usb.decimals()))).not.to.be.rejected;
    await expect(vf.ethVaultPtyPoolBuyLow.connect(vf.Bob).stake(ethers.parseUnits("10000", await vf.usb.decimals()))).not.to.be.rejected;

    console.log(`\nBefore PtyPoolBuyLow triggered`);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    await expectMintPair("0.1", 1600n);
    console.log(`\nAfter depositing 0.1 $ETH and PtyPoolBuyLow triggered`);
    await printVaultState(vf.ethVault, vf.vaultQuery);
    console.log(`ETH Vault asset balance: ${ethers.formatEther(await vf.ethVault.assetBalance())} $ETH`);
    console.log(`ETH Vault token pot balance: ${ethers.formatEther(await ethers.provider.getBalance(await vf.ethVault.tokenPot()))} $ETH`);
    console.log(`ETH Vault PtyPoolBuyLow Alice staking balance: ${ethers.formatUnits(await vf.ethVaultPtyPoolBuyLow.userStakingBalance(vf.Alice.address), 18)} $USB`);
    console.log(`ETH Vault PtyPoolBuyLow Alice earned: ${ethers.formatEther(await vf.ethVaultPtyPoolBuyLow.earnedMatchedToken(vf.Alice.address))} $ETH`);
    console.log(`ETH Vault PtyPoolBuyLow Bob staking balance: ${ethers.formatUnits(await vf.ethVaultPtyPoolBuyLow.userStakingBalance(vf.Bob.address), 18)} $USB`);
    console.log(`ETH Vault PtyPoolBuyLow Bob earned: ${ethers.formatEther(await vf.ethVaultPtyPoolBuyLow.earnedMatchedToken(vf.Bob.address))} $ETH`);

  });

  it("All Redeem work", async () => {
    await vf.settings.connect(vf.Alice).updateVaultParamValue(await vf.ethVault.getAddress(), encodeBytes32String("Y"), 0);
    await expectMintPair("4", 2300n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    // to Low
    await expectRedeemByPairWithUsb("1000", 1800n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    // Already to low
    await expectRedeemByUsbAARS("1000", 1800n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    await expectRedeemByPairWithUsb("1000", 1800n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    // expect to High
    await expectRedeemByPairWithUsb("100", 3200n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    // Already to High
    await expectRedeemByXtokenAARU("0.5", 3200n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    // expect to stable
    await expectRedeemByPairWithUsb("100", 1700n);
    await printVaultState(vf.ethVault, vf.vaultQuery);

    // Already to stable
  });
});
