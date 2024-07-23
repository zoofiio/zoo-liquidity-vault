// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

import "../libs/Constants.sol";
import "../libs/VaultCalculator.sol";
import "../libs/StableVaultCalculator.sol";
import "../interfaces/IVault.sol";
import "./Vault.sol";
import "./StableVault.sol";

contract VaultQuery {
  using VaultCalculator for Vault;
  using StableVaultCalculator for StableVault;

  function AAR(Vault vault) public view returns (uint256) {
    return vault.AAR();
  }

  function getVaultState(Vault vault) external view returns (Constants.VaultState memory) {
    return vault.getVaultState();
  }

  function calcMintPairs(Vault vault, uint256 assetAmount) external view returns (Constants.VaultState memory, uint256, uint256) {
    return vault.calcMintPairs(assetAmount);
  }

  function calcMintUsbAboveAARU(Vault vault, uint256 assetAmount) external view returns (Constants.VaultState memory, uint256) {
    return vault.calcMintUsbAboveAARU(assetAmount);
  }

  function calcMintMarginTokensBelowAARS(Vault vault, uint256 assetAmount) external view returns (Constants.VaultState memory, uint256) {
    return vault.calcMintMarginTokensBelowAARS(assetAmount);
  }

  function calcPairdMarginTokenAmount(Vault vault, uint256 usbAmount) external view returns (uint256) {
    return vault.calcPairdMarginTokenAmount(usbAmount);
  }

  function calcPairedUsbAmount(Vault vault, uint256 marginTokenAmount) external view returns (uint256) {
    return vault.calcPairedUsbAmount(marginTokenAmount);
  }

  function calcPairedRedeemAssetAmount(Vault vault, uint256 marginTokenAmount) external view returns (Constants.VaultState memory, uint256) {
    return vault.calcPairedRedeemAssetAmount(marginTokenAmount);
  }

  function calcRedeemByMarginTokenAboveAARU(Vault vault, uint256 marginTokenAmount) external view returns (Constants.VaultState memory, uint256) {
    return vault.calcRedeemByMarginTokenAboveAARU(marginTokenAmount);
  }

  function calcRedeemByUsbBelowAARS(Vault vault, uint256 usbAmount) external view returns (Constants.VaultState memory, uint256) {
    return vault.calcRedeemByUsbBelowAARS(usbAmount);
  }

  function calcUsbToMarginTokens(Vault vault, IProtocolSettings settings, uint256 usbAmount) external view returns (Constants.VaultState memory, uint256) {
    return vault.calcUsbToMarginTokens(settings, usbAmount);
  }

  function getStableVaultState(StableVault vault) external view returns (Constants.StableVaultState memory) {
    return vault.getStableVaultState();
  }

  function calcMintUsbFromStableVault(StableVault vault, uint256 assetAmount) external view returns (Constants.StableVaultState memory, uint256) {
    return vault.calcMintUsbFromStableVault(assetAmount);
  }

  function calcMintMarginTokensFromStableVault(StableVault vault, uint256 assetAmount) external view returns (Constants.StableVaultState memory, uint256) {
    return vault.calcMintMarginTokensFromStableVault(assetAmount);
  }

  function calcMintPairsFromStableVault(StableVault vault, uint256 assetAmount) public view returns (Constants.StableVaultState memory, uint256, uint256) {
    return vault.calcMintPairsFromStableVault(assetAmount);
  }

  function calcRedeemByUsbFromStableVault(StableVault vault, IProtocolSettings settings, uint256 usbAmount) external view returns (Constants.StableVaultState memory, uint256, uint256, uint256) {
    return vault.calcRedeemByUsbFromStableVault(settings, usbAmount);
  }

  function calcRedeemByMarginTokensFromStableVault(StableVault vault, IProtocolSettings settings, uint256 marginTokenAmount) external view returns (Constants.StableVaultState memory, uint256, uint256, uint256) {
    return vault.calcRedeemByMarginTokensFromStableVault(settings, marginTokenAmount);
  }

  function calcPairdMarginTokenAmountForStableVault(StableVault vault, uint256 usbAmount) external view returns (uint256) {
    return vault.calcPairdMarginTokenAmountForStableVault(usbAmount);
  }

  function calcPairedUsbAmountForStableVault(StableVault vault, uint256 marginTokenAmount) external view returns (uint256) {
    return vault.calcPairedUsbAmountForStableVault(marginTokenAmount);
  }

  function calcRedeemByPairsAssetAmountForStableVault(StableVault vault, IProtocolSettings settings, uint256 marginTokenAmount) external view returns (Constants.StableVaultState memory, uint256, uint256, uint256) {
    return vault.calcRedeemByPairsAssetAmountForStableVault(settings, marginTokenAmount);
  }

  function calcUsbToMarginTokensForStableVault(StableVault vault, IProtocolSettings settings, uint256 usbAmount) external view returns (Constants.StableVaultState memory, uint256) {
    return  vault.calcUsbToMarginTokensForStableVault(settings, usbAmount);
  }
}
