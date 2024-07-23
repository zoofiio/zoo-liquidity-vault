// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

// import "hardhat/console.sol";

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "./Constants.sol";
import "../interfaces/IMarginToken.sol";
import "../interfaces/IProtocolSettings.sol";
import "../interfaces/IPtyPool.sol";
import "../interfaces/IUsb.sol";
import "../interfaces/IVault.sol";

library VaultCalculator {
  using SafeMath for uint256;

  function vaultAssetTokenDecimals(IVault self) public view returns (uint8) {
    address assetToken = self.assetToken();
    if (assetToken == Constants.NATIVE_TOKEN) {
      return 18;
    }
    return IERC20Metadata(assetToken).decimals();
  }

  /**
   * @dev AAReth = (M_ETH * P_ETH / Musb-eth) * 100%
   */
  function AAR(IVault self) public view returns (uint256) {
    uint256 assetTotalAmount = self.assetBalance();
    if (assetTotalAmount == 0) {
      return 0;
    }
    if (self.usbTotalSupply() == 0) {
      return type(uint256).max;
    }
    (uint256 assetTokenPrice, uint256 assetTokenPriceDecimals) = self.assetTokenPrice();
    return assetTotalAmount.mul(assetTokenPrice).div(10 ** assetTokenPriceDecimals).mul(10 ** self.AARDecimals()).div(self.usbTotalSupply());
  }

  function getVaultState(IVault self) public view returns (Constants.VaultState memory) {
    Constants.VaultState memory S;
    S.M_ETH = self.assetBalance();
    (S.P_ETH, S.P_ETH_DECIMALS) = self.assetTokenPrice();
    S.M_USB_ETH = self.usbTotalSupply();
    S.M_ETHx = IERC20(self.marginToken()).totalSupply();
    S.aar = AAR(self);
    S.AART = self.paramValue("AART");
    S.AARS = self.paramValue("AARS");
    S.AARU = self.paramValue("AARU");
    S.AARC = self.paramValue("AARC");
    S.AARDecimals = self.AARDecimals();
    S.RateR = self.paramValue("RateR");
    S.AARBelowSafeLineTime = self.AARBelowSafeLineTime();
    S.AARBelowCircuitBreakerLineTime = self.AARBelowCircuitBreakerLineTime();
    return S;
  }

  function calcMintPairs(IVault self, uint256 assetAmount) public view returns (Constants.VaultState memory, uint256, uint256) {
    // Constants.VaultMode vaultMode = self.vaultMode();
    // require(vaultMode == Constants.VaultMode.Empty || vaultMode == Constants.VaultMode.Stability, "Vault not in stability mode");
    Constants.VaultState memory S = getVaultState(self);

    uint256 usbOutAmount;
    uint256 marginTokenOutAmount;
    if (S.M_USB_ETH > 0 && S.M_ETHx > 0) {
      // ΔUSB = ΔETH * M_USB_ETH / M_ETH
      // ΔETHx = ΔUSB * M_ETHx / M_USB_ETH
      usbOutAmount = assetAmount.mul(S.M_USB_ETH).div(S.M_ETH);
      marginTokenOutAmount = usbOutAmount.mul(S.M_ETHx).div(S.M_USB_ETH);
    } else {
      // ΔUSB = ΔETH * P_ETH * 1 / AART
      // ΔETHx = ΔETH * (1 - 1 / AART) = ΔETH * (AART - 1) / AART
      Constants.Terms memory T;
      T.T1 = assetAmount.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS);
      usbOutAmount = T.T1.mul(10 ** S.AARDecimals).div(S.AART);
      marginTokenOutAmount = assetAmount.mul(S.AART.sub(10 ** S.AARDecimals)).div(S.AART);
    }
    return (S, usbOutAmount, marginTokenOutAmount);
  }

  function calcMintUsbAboveAARU(IVault self, uint256 assetAmount) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultMode vaultMode = self.vaultMode();
    require(vaultMode == Constants.VaultMode.AdjustmentAboveAARU, "Vault not in adjustment above AARU mode");

    Constants.VaultState memory S = getVaultState(self);

    // ΔUSB = ΔETH * P_ETH
    uint256 usbOutAmount = assetAmount.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS);
    return (S, usbOutAmount);
  }

  function calcMintMarginTokensBelowAARS(IVault self, uint256 assetAmount) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultMode vaultMode = self.vaultMode();
    require(vaultMode == Constants.VaultMode.AdjustmentBelowAARS, "Vault not in adjustment below AARS mode");

    Constants.VaultState memory S = getVaultState(self);

    uint256 aar101 = (101 * (10 ** (S.AARDecimals - 2)));
    uint256 marginTokenOutAmount;
    
    if (S.aar >= aar101) { // aar >= 101% 
      // ΔETHx = ΔETH * P_ETH * M_ETHx / (M_ETH * P_ETH - Musb-eth)
      marginTokenOutAmount = assetAmount.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS).mul(S.M_ETHx).div(
        S.M_ETH.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS).sub(S.M_USB_ETH)
      );
    }
    else { //  aar < 101% 
      // ΔETHx = ΔETH * P_ETH * M_ETHx * 100 / Musb-eth
      marginTokenOutAmount = assetAmount.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS).mul(S.M_ETHx).mul(100).div(S.M_USB_ETH);
    }

    return (S, marginTokenOutAmount);
  }

  function calcPairdMarginTokenAmount(IVault self, uint256 usbAmount) public view returns (uint256) {
    Constants.VaultState memory S = getVaultState(self);

    // ΔUSB = ΔETHx * Musb-eth / M_ETHx
    // ΔETHx = ΔUSB * M_ETHx / Musb-eth
    uint256 marginTokenOutAmount = usbAmount.mul(S.M_ETHx).div(S.M_USB_ETH);
    return marginTokenOutAmount;
  }

  function calcPairedUsbAmount(IVault self, uint256 marginTokenAmount) public view returns (uint256) {
    Constants.VaultState memory S = getVaultState(self);

    // ΔUSB = ΔETHx * Musb-eth / M_ETHx
    // ΔETHx = ΔUSB * M_ETHx / Musb-eth
    uint256 usbOutAmount = marginTokenAmount.mul(S.M_USB_ETH).div(S.M_ETHx);
    return usbOutAmount;
  }

  function calcPairedRedeemAssetAmount(IVault self, uint256 marginTokenAmount) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultState memory S = getVaultState(self);

    // ΔETH = ΔETHx * M_ETH / M_ETHx
    uint256 assetOutAmount = marginTokenAmount.mul(S.M_ETH).div(S.M_ETHx);
    return (S, assetOutAmount);
  }

  function calcRedeemByMarginTokenAboveAARU(IVault self, uint256 marginTokenAmount) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultMode vaultMode = self.vaultMode();
    require(vaultMode == Constants.VaultMode.AdjustmentAboveAARU, "Vault not in adjustment above AARU mode");

    Constants.VaultState memory S = getVaultState(self);

    // ΔETH = ΔETHx * (M_ETH * P_ETH - Musb-eth) / (M_ETHx * P_ETH)
    uint256 assetOutAmount = marginTokenAmount.mul(
      S.M_ETH.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS).sub(S.M_USB_ETH)
    ).div(S.M_ETHx.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS));
    return (S, assetOutAmount);
  }

  function calcRedeemByUsbBelowAARS(IVault self, uint256 usbAmount) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultMode vaultMode = self.vaultMode();
    require(vaultMode == Constants.VaultMode.AdjustmentBelowAARS, "Vault not in adjustment below AARS mode");

    Constants.VaultState memory S = getVaultState(self);

    if (S.aar < (10 ** S.AARDecimals)) {
      // ΔETH = ΔUSB * M_ETH / Musb-eth
      uint256 assetOutAmount = usbAmount.mul(S.M_ETH).div(S.M_USB_ETH);
      return (S, assetOutAmount);
    }
    else {
      // ΔETH = ΔUSB / P_ETH
      uint256 assetOutAmount = usbAmount.mul(10 ** S.P_ETH_DECIMALS).div(S.P_ETH);
      return (S, assetOutAmount);
    }
  }

  function calcUsbToMarginTokens(IVault self, IProtocolSettings settings, uint256 usbAmount) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultMode vaultMode = self.vaultMode();
    require(vaultMode == Constants.VaultMode.AdjustmentBelowAARS, "Vault not in adjustment mode");

    Constants.VaultState memory S = getVaultState(self);
    require(S.aar >= S.AARC || (block.timestamp.sub(S.AARBelowCircuitBreakerLineTime) >= self.paramValue("CircuitBreakPeriod")), "Conditional Discount Purchase suspended");

    uint256 aar101 = (101 * (10 ** (S.AARDecimals - 2)));
    uint256 marginTokenOutAmount;
    
    if (S.aar >= aar101) { // aar >= 101% 
      // ΔETHx = ΔUSB * M_ETHx * (1 + r) / (M_ETH * P_ETH - Musb-eth)
      Constants.Terms memory T;
      T.T1 = usbAmount.mul(S.M_ETHx).mul((10 ** settings.decimals()).add(_r(S.AARBelowSafeLineTime, S.RateR)));
      marginTokenOutAmount = T.T1.div(
        S.M_ETH.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS).sub(S.M_USB_ETH)
      ).div(10 ** settings.decimals());
    }
    else { //  aar < 101% 
      // ΔETHx = ΔUSB * M_ETHx * 100 / Musb-eth
      marginTokenOutAmount = usbAmount.mul(S.M_ETHx).mul(100).div(S.M_USB_ETH);
    }
    return (S, marginTokenOutAmount);
  }

  // 𝑟 = self.RateR() × 𝑡(h𝑟𝑠), since aar drop below 1.3;
  // r = 0 since aar above 2;
  function _r(uint256 aarBelowSafeLineTime, uint256 rateR) internal view returns (uint256) {
    if (aarBelowSafeLineTime == 0) {
      return 0;
    }
    return rateR.mul(block.timestamp.sub(aarBelowSafeLineTime)).div(1 hours);
  }

  function calcDeltaUsbForPtyPoolBuyLow(IVault self, IProtocolSettings settings, address usbToken, address ptyPoolBuyLow) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultState memory S = getVaultState(self);

    // ΔETH = (Musb-eth * AART - M_ETH * P_ETH) / (P_ETH * (AART - 1))
    // ΔUSB = (Musb-eth * AART - M_ETH * P_ETH) / (AART - 1)
    uint256 deltaUsbAmount = S.M_USB_ETH.mul(S.AART).sub(
      S.M_ETH.mul(S.P_ETH).mul(10 ** S.AARDecimals).div(10 ** S.P_ETH_DECIMALS)
    ).div(S.AART.sub(10 ** S.AARDecimals));

    uint256 minUsbAmount = self.paramValue("PtyPoolMinUsbAmount");
    // Convert to $USB decimals
    minUsbAmount = minUsbAmount.mul(10 ** ((IUsb(usbToken).decimals() - settings.decimals())));
    uint256 ptyPoolUsbBalance = IERC20(usbToken).balanceOf(ptyPoolBuyLow);
    if (ptyPoolUsbBalance <= minUsbAmount) {
      return (S, 0);
    }
    // console.log('calcDeltaUsbForPtyPoolBuyLow, minUsbAmount: %s, deltaUsbAmount: %s', minUsbAmount, deltaUsbAmount);
    deltaUsbAmount = deltaUsbAmount > ptyPoolUsbBalance.sub(minUsbAmount) ? ptyPoolUsbBalance.sub(minUsbAmount) : deltaUsbAmount;
    return (S, deltaUsbAmount);
  }

  function calcDeltaAssetForPtyPoolSellHigh(IVault self, IProtocolSettings settings, address ptyPoolSellHigh) public view returns (Constants.VaultState memory, uint256) {
    Constants.VaultState memory S = getVaultState(self);

    // ΔETH = (M_ETH * P_ETH - Musb-eth * AART) / (P_ETH * (AART - 1))
    uint256 deltaAssetAmount = S.M_ETH.mul(S.P_ETH).mul(10 ** S.AARDecimals).sub(
      S.M_USB_ETH.mul(S.AART).mul(10 ** S.P_ETH_DECIMALS)
    ).div(S.P_ETH.mul(S.AART.sub(10 ** S.AARDecimals)));

    uint256 minAssetAmount = self.paramValue("PtyPoolMinAssetAmount");
    if (self.assetTokenDecimals() > settings.decimals()) {
      minAssetAmount = minAssetAmount.mul(10 ** (self.assetTokenDecimals() - settings.decimals()));
    }
    else {
      minAssetAmount = minAssetAmount.div(10 ** (settings.decimals() - self.assetTokenDecimals()));
    }

    uint256 ptyPoolAssetBalance = IPtyPool(ptyPoolSellHigh).totalStakingBalance();
    if (ptyPoolAssetBalance <= minAssetAmount) {
      return (S, 0);
    }
    // console.log('calcDeltaAssetForPtyPoolSellHigh, minAssetAmount: %s, deltaAssetAmount: %s', minAssetAmount, deltaAssetAmount);

    deltaAssetAmount = deltaAssetAmount > ptyPoolAssetBalance.sub(minAssetAmount) ? ptyPoolAssetBalance.sub(minAssetAmount) : deltaAssetAmount;
    return (S, deltaAssetAmount);
  }

  function calcRedeemFees(IVault self, IProtocolSettings settings, uint256 assetAmount) public view returns (uint256, uint256, uint256, uint256) {
    require(assetAmount <= self.assetBalance(), "Not enough asset balance");

    uint256 totalFees = assetAmount.mul(settings.vaultParamValue(address(self), "C")).div(10 ** settings.decimals());
    uint256 feesToTreasury = totalFees.mul(settings.vaultParamValue(address(self), "TreasuryFeeRate")).div(10 ** settings.decimals());

    uint256 feesToPtyPoolBuyLow = totalFees.sub(feesToTreasury).mul(settings.vaultParamValue(address(self), "PtyPoolBuyLowFeeRate")).div(10 ** settings.decimals());
    uint256 feesToPtyPoolSellHigh = totalFees.sub(feesToTreasury).sub(feesToPtyPoolBuyLow);

    uint256 netRedeemAmount = assetAmount.sub(feesToTreasury).sub(feesToPtyPoolBuyLow).sub(feesToPtyPoolSellHigh);
    return (netRedeemAmount, feesToTreasury, feesToPtyPoolBuyLow, feesToPtyPoolSellHigh);
  }

  function calcSettleYields(
    IVault self, IProtocolSettings settings, uint256 yieldsBaseAssetAmount,
    uint256 lastYieldsSettlementTime
  ) public view returns (uint256, uint256) {
    uint256 usbOutAmount = 0;
    uint256 marginTokenOutAmount = 0;

    uint256 timeElapsed = block.timestamp.sub(lastYieldsSettlementTime);
    uint256 Y = settings.vaultParamValue(address(self), "Y");
    uint256 deltaAssetAmount = timeElapsed.mul(Y).mul(yieldsBaseAssetAmount).div(365 days).div(10 ** settings.decimals());
    if (deltaAssetAmount > 0) {
      Constants.VaultState memory S;
      (S, usbOutAmount, marginTokenOutAmount) = calcMintPairs(self, deltaAssetAmount);
    }

    return (usbOutAmount, marginTokenOutAmount);
  }

  function paramValue(IVault self, IProtocolSettings settings, bytes32 paramName) public view returns (uint256) {
    return settings.vaultParamValue(address(self), paramName);
  }

  function getParamAARs(IVault self, IProtocolSettings settings) public view returns (uint256, uint256, uint256, uint256) {
    return (
      settings.vaultParamValue(address(self), "AART"),
      settings.vaultParamValue(address(self), "AARS"),
      settings.vaultParamValue(address(self), "AARU"),
      settings.vaultParamValue(address(self), "AARC")
    );
  }

  function calcPtyPoolMinAssetAmount(IVault self, IProtocolSettings settings) public view returns (uint256) {
    uint256 minAssetAmount = settings.vaultParamValue(address(self), "PtyPoolMinAssetAmount");
    if (vaultAssetTokenDecimals(self) > settings.decimals()) {
      minAssetAmount = minAssetAmount.mul(10 ** (vaultAssetTokenDecimals(self) - settings.decimals()));
    }
    else {
      minAssetAmount = minAssetAmount.div(10 ** (settings.decimals() - vaultAssetTokenDecimals(self)));
    }
    return minAssetAmount;
  }

}