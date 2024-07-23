// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

// import "hardhat/console.sol";

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";

import "../libs/Constants.sol";
import "../libs/TokensTransfer.sol";
import "../libs/VaultCalculator.sol";
import "../interfaces/IMarginToken.sol";
import "../interfaces/IPriceFeed.sol";
import "../interfaces/IProtocolSettings.sol";
import "../interfaces/IPtyPoolBuyLow.sol";
import "../interfaces/IPtyPoolSellHigh.sol";
import "../interfaces/IUsb.sol";
import "../interfaces/IVault.sol";
import "../interfaces/IZooProtocol.sol";
import "../settings/ProtocolOwner.sol";
import "./TokenPot.sol";

contract Vault is IVault, ReentrancyGuard, ProtocolOwner {
  using SafeMath for uint256;
  using VaultCalculator for Vault;

  bool internal _mintPaused;
  bool internal _redeemPaused;
  bool internal _usbToMarginTokensPaused;

  IProtocolSettings public immutable settings;
  TokenPot public immutable tokenPot;
  IPtyPoolBuyLow public ptyPoolBuyLow;
  IPtyPoolSellHigh public ptyPoolSellHigh;

  uint256 internal _accruedStakingYieldsForPtyPoolBuyLow; // $ETHx
  uint256 internal _accruedMatchingYieldsForPtyPoolBuyLow; // $ETH
  uint256 internal _accruedStakingYieldsForPtyPoolSellHigh; // $ETH
  uint256 internal _accruedMatchingYieldsForPtyPoolSellHigh; // $ETHx
  
  address internal immutable _assetToken;
  address internal immutable _usbToken;
  address internal immutable _marginToken;

  uint256 internal _usbTotalSupply;

  Constants.VaultMode internal _vaultMode;

  uint256 internal _lastYieldsSettlementTime;

  uint256 internal _previousAAR;
  uint256 internal _aarBelowSafeLineTime;
  uint256 internal _aarBelowCircuitBreakerLineTime;

  IPriceFeed public priceFeed;

  constructor(
    address _protocol,
    address _settings,
    address _assetToken_,
    address _marginToken_,
    address _assetTokenPriceFeed_
  ) ProtocolOwner(_protocol) {
    require(
      _settings != address(0) && _assetToken_ != address(0) && _marginToken_ != address(0) && _assetTokenPriceFeed_ != address(0), 
      "Zero address detected"
    );
    // require((tx.origin == protocol.protocolOwner()) || (_msgSender() == protocol.protocolOwner()) , "Vault should only be created by protocol owner");

    tokenPot = new TokenPot(_protocol, _settings);
    _assetToken = _assetToken_;
    _marginToken = _marginToken_;
    _usbToken = protocol.usbToken();

    settings = IProtocolSettings(_settings);
    _vaultMode = Constants.VaultMode.Empty;

    _mintPaused = false;
    _redeemPaused = false;
    _usbToMarginTokensPaused = false;
    priceFeed = IPriceFeed(_assetTokenPriceFeed_);
  }

  receive() external payable {
    require(_assetToken == Constants.NATIVE_TOKEN);
    TokensTransfer.transferTokens(_assetToken, address(this), address(tokenPot), msg.value);
  }

  /* ================= VIEWS ================ */

  function paused() external view virtual returns (bool, bool, bool) {
    return (_mintPaused, _redeemPaused, _usbToMarginTokensPaused);
  }

  function usbToken() external view override returns (address) {
    return _usbToken;
  }

  function vaultType() external pure override returns (Constants.VaultType) {
    return Constants.VaultType.Volatile;
  }

  function usbTotalSupply() public view override returns (uint256) {
    return _usbTotalSupply;
  }

  function assetBalance() public view override returns (uint256) {
    return tokenPot.balance(_assetToken).sub(
      _accruedMatchingYieldsForPtyPoolBuyLow
    ).sub(_accruedStakingYieldsForPtyPoolSellHigh);
  }

  function assetToken() public view override returns (address) {
    return _assetToken;
  }

  function assetTokenDecimals() public view override returns (uint8) {
    return this.vaultAssetTokenDecimals();
  }

  function assetTokenPrice() external view override returns (uint256, uint256) {
    return _assetTokenPrice();
  }

  function marginToken() public view override returns (address) {
    return _marginToken;
  }

  function paramValue(bytes32 param) public view override returns (uint256) {
    return settings.vaultParamValue(address(this), param);
  }

  function vaultMode() external view override returns (Constants.VaultMode) {
    return _vaultMode;
  }

  function AARDecimals() public pure returns (uint256) {
    return Constants.PROTOCOL_DECIMALS;
  }

  function AARBelowSafeLineTime() public view returns (uint256) {
    return _aarBelowSafeLineTime;
  }

  function AARBelowCircuitBreakerLineTime() public view returns (uint256) {
    return _aarBelowCircuitBreakerLineTime;
  }

  /* ========== Mint FUNCTIONS ========== */

  function mintPairs(uint256 assetAmount) external payable nonReentrant whenMintNotPaused noneZeroValue(assetAmount) validMsgValue(assetAmount) onUserAction(true) {
    (Constants.VaultState memory S, uint256 usbOutAmount, uint256 marginTokenOutAmount) = this.calcMintPairs(assetAmount);
    _doMint(assetAmount, S, usbOutAmount, marginTokenOutAmount);
  }

  function mintUsbAboveAARU(uint256 assetAmount) external payable nonReentrant whenMintNotPaused noneZeroValue(assetAmount) validMsgValue(assetAmount) onUserAction(true) {
    (Constants.VaultState memory S, uint256 usbOutAmount) = this.calcMintUsbAboveAARU(assetAmount);
    _doMint(assetAmount, S, usbOutAmount, 0);
  }

  function mintMarginTokensBelowAARS(uint256 assetAmount) external payable nonReentrant whenMintNotPaused noneZeroValue(assetAmount) validMsgValue(assetAmount) onUserAction(true) {
    (Constants.VaultState memory S, uint256 marginTokenOutAmount) = this.calcMintMarginTokensBelowAARS(assetAmount);
    _doMint(assetAmount, S, 0, marginTokenOutAmount);
  }

   /* ========== Redeem FUNCTIONS ========== */

  function redeemByPairsWithExpectedUsbAmount(uint256 usbAmount) external nonReentrant whenRedeemNotPaused noneZeroValue(usbAmount) onUserAction(true) {
    require(usbAmount <= IUsb(_usbToken).balanceOf(_msgSender()), "Not enough USB balance");
    
    uint256 pairdMarginTokenAmount = this.calcPairdMarginTokenAmount(usbAmount);
    require(pairdMarginTokenAmount <= IMarginToken(_marginToken).balanceOf(_msgSender()), "Not enough margin token balance");

    (Constants.VaultState memory S, uint256 assetOutAmount) = this.calcPairedRedeemAssetAmount(pairdMarginTokenAmount);
    uint256 netRedeemAmount = _doRedeem(assetOutAmount, S, usbAmount, pairdMarginTokenAmount);

    emit AssetRedeemedWithPairs(_msgSender(), usbAmount, pairdMarginTokenAmount, netRedeemAmount, S.P_ETH, S.P_ETH_DECIMALS);
  }

  function redeemByPairsWithExpectedMarginTokenAmount(uint256 marginTokenAmount) external nonReentrant whenRedeemNotPaused noneZeroValue(marginTokenAmount) onUserAction(true) {
    require(marginTokenAmount <= IMarginToken(_marginToken).balanceOf(_msgSender()), "Not enough margin token balance");

    uint256 pairedUSBAmount = this.calcPairedUsbAmount(marginTokenAmount);
    require(pairedUSBAmount <= IUsb(_usbToken).balanceOf(_msgSender()), "Not enough USB balance");

    (Constants.VaultState memory S, uint256 assetOutAmount) = this.calcPairedRedeemAssetAmount(marginTokenAmount);
    uint256 netRedeemAmount = _doRedeem(assetOutAmount, S, pairedUSBAmount, marginTokenAmount);

    emit AssetRedeemedWithPairs(_msgSender(), pairedUSBAmount, marginTokenAmount, netRedeemAmount, S.P_ETH, S.P_ETH_DECIMALS);
  }

  function redeemByMarginTokenAboveAARU(uint256 marginTokenAmount) external nonReentrant whenRedeemNotPaused noneZeroValue(marginTokenAmount) onUserAction(true) {
    require(marginTokenAmount <= IMarginToken(_marginToken).balanceOf(_msgSender()), "Not enough margin token balance");
    
    (Constants.VaultState memory S, uint256 assetOutAmount) = this.calcRedeemByMarginTokenAboveAARU(marginTokenAmount);
    uint256 netRedeemAmount = _doRedeem(assetOutAmount, S, 0, marginTokenAmount);

    emit AssetRedeemedWithMarginToken(_msgSender(), marginTokenAmount, netRedeemAmount, S.P_ETH, S.P_ETH_DECIMALS);
  }

  function redeemByUsbBelowAARS(uint256 usbAmount) external nonReentrant whenRedeemNotPaused noneZeroValue(usbAmount) onUserAction(true) {
    require(usbAmount <= IUsb(_usbToken).balanceOf(_msgSender()), "Not enough USB balance");
    
    (Constants.VaultState memory S, uint256 assetOutAmount) = this.calcRedeemByUsbBelowAARS(usbAmount);
    uint256 netRedeemAmount = _doRedeem(assetOutAmount, S, usbAmount, 0);

    emit AssetRedeemedWithUSB(_msgSender(), usbAmount, netRedeemAmount, S.P_ETH, S.P_ETH_DECIMALS);
  }

  /* ========== Other FUNCTIONS ========== */

  function usbToMarginTokens(uint256 usbAmount) external nonReentrant whenUsbToMarginTokensNotPaused noneZeroValue(usbAmount) onUserAction(false) {  
    require(usbAmount <= IUsb(_usbToken).balanceOf(_msgSender()), "Not enough USB balance");
    
    (Constants.VaultState memory S, uint256 marginTokenAmount) = this.calcUsbToMarginTokens(settings, usbAmount);
    
    uint256 usbSharesAmount = IUsb(_usbToken).burn(_msgSender(), usbAmount);
    _usbTotalSupply = _usbTotalSupply.sub(usbAmount);
    emit UsbBurned(_msgSender(), usbAmount, usbSharesAmount, S.P_ETH, S.P_ETH_DECIMALS);

    IMarginToken(_marginToken).mint(_msgSender(), marginTokenAmount);
    emit MarginTokenMinted(_msgSender(), 0, marginTokenAmount, S.P_ETH, S.P_ETH_DECIMALS);

    emit UsbToMarginTokens(_msgSender(), usbAmount, marginTokenAmount, S.P_ETH, S.P_ETH_DECIMALS);
  }

  /* ========== RESTRICTED FUNCTIONS ========== */

  function pauseMint() external nonReentrant onlyOwner {
    _mintPaused = true;
    emit MintPaused();
  }

  function unpauseMint() external nonReentrant onlyOwner {
    _mintPaused = false;
    emit MintUnpaused();
  }

  function pauseRedeem() external nonReentrant onlyOwner {
    _redeemPaused = true;
    emit RedeemPaused();
  }

  function unpauseRedeem() external nonReentrant onlyOwner {
    _redeemPaused = false;
    emit RedeemUnpaused();
  }

  function pauseUsbToMarginTokens() external nonReentrant onlyOwner {
    _usbToMarginTokensPaused = true;
    emit UsbToMarginTokensPaused();
  }

  function unpauseUsbToMarginTokens() external nonReentrant onlyOwner {
    _usbToMarginTokensPaused = false;
    emit UsbToMarginTokensUnpaused();
  }

  function setPtyPools(address _ptyPoolBuyLow, address _ptyPoolSellHigh) external nonReentrant onlyOwner {
    require(_ptyPoolBuyLow != address(0) && _ptyPoolSellHigh != address(0), "Zero address detected");
    // require(ptyPoolBuyLow == IPtyPool(address(0)) && ptyPoolSellHigh == IPtyPool(address(0)), "PtyPools already set");
    require(IPtyPool(_ptyPoolBuyLow).vault() == address(this) && IPtyPool(_ptyPoolSellHigh).vault() == address(this), "Invalid vault");
    
    ptyPoolBuyLow = IPtyPoolBuyLow(_ptyPoolBuyLow);
    ptyPoolSellHigh = IPtyPoolSellHigh(_ptyPoolSellHigh);
  }

  function updatePriceFeed(address _assetTokenPriceFeed_) external nonReentrant onlyOwner {
    require(_assetTokenPriceFeed_ != address(0), "Zero address detected");
    priceFeed = IPriceFeed(_assetTokenPriceFeed_);
  }

  /* ========== INTERNAL FUNCTIONS ========== */

  function _doMint(uint256 assetAmount, Constants.VaultState memory S, uint256 usbOutAmount, uint256 marginTokenOutAmount) internal {
    if (_assetToken == Constants.NATIVE_TOKEN) {
      TokensTransfer.transferTokens(_assetToken, address(this), address(tokenPot), assetAmount);
    }
    else {
      TokensTransfer.transferTokens(_assetToken, _msgSender(), address(tokenPot), assetAmount);
    }

    if (usbOutAmount > 0) {
      uint256 usbSharesAmount = IUsb(_usbToken).mint(_msgSender(), usbOutAmount);
      _usbTotalSupply = _usbTotalSupply.add(usbOutAmount);
      emit UsbMinted(_msgSender(), assetAmount, usbOutAmount, usbSharesAmount, S.P_ETH, S.P_ETH_DECIMALS);
    }

    if (marginTokenOutAmount > 0) {
      IMarginToken(_marginToken).mint(_msgSender(), marginTokenOutAmount);
      emit MarginTokenMinted(_msgSender(), assetAmount, marginTokenOutAmount, S.P_ETH, S.P_ETH_DECIMALS);
    }
  }

  function _doRedeem(uint256 assetAmount, Constants.VaultState memory S, uint256 usbAmount, uint256 marginTokenAmount) internal returns (uint256) {
    (uint256 netRedeemAmount, uint256 feesToTreasury, uint256 feesToPtyPoolBuyLow, uint256 feesToPtyPoolSellHigh) = this.calcRedeemFees(settings, assetAmount);

    tokenPot.withdraw(_msgSender(), _assetToken, netRedeemAmount);
    if (feesToTreasury > 0) {
      tokenPot.withdraw(settings.treasury(), _assetToken, feesToTreasury);
    }
    // console.log('_doRedeem, asset: %s, feesToTreasury: %s, netRedeemAmount: %s', totalFees, feesToTreasury, netRedeemAmount);

    _accruedMatchingYieldsForPtyPoolBuyLow = _accruedMatchingYieldsForPtyPoolBuyLow.add(feesToPtyPoolBuyLow);
    if (_accruedMatchingYieldsForPtyPoolBuyLow > 0 && ptyPoolBuyLow.totalStakingShares() > 0) {
      tokenPot.withdraw(address(ptyPoolBuyLow), _assetToken, _accruedMatchingYieldsForPtyPoolBuyLow);
      ptyPoolBuyLow.addMatchingYields(_accruedMatchingYieldsForPtyPoolBuyLow);
      _accruedMatchingYieldsForPtyPoolBuyLow = 0;
    }

    _accruedStakingYieldsForPtyPoolSellHigh = _accruedStakingYieldsForPtyPoolSellHigh.add(feesToPtyPoolSellHigh);
    if (_accruedStakingYieldsForPtyPoolSellHigh > 0 && ptyPoolSellHigh.totalStakingShares() > 0) {
      tokenPot.withdraw(address(ptyPoolSellHigh), _assetToken, _accruedStakingYieldsForPtyPoolSellHigh);
      ptyPoolSellHigh.addStakingYields(_accruedStakingYieldsForPtyPoolSellHigh);
      _accruedStakingYieldsForPtyPoolSellHigh = 0;
    }

    if (usbAmount > 0) {
      uint256 usbBurnShares = IUsb(_usbToken).burn(_msgSender(), usbAmount);
      _usbTotalSupply = _usbTotalSupply.sub(usbAmount);
      emit UsbBurned(_msgSender(), usbAmount, usbBurnShares, S.P_ETH, S.P_ETH_DECIMALS);
    }

    if (marginTokenAmount > 0) {
      IMarginToken(_marginToken).burn(_msgSender(), marginTokenAmount);
      emit MarginTokenBurned(_msgSender(), marginTokenAmount, S.P_ETH, S.P_ETH_DECIMALS);
    }

    return netRedeemAmount;
  }

  function _ptyPoolMatchBelowAARS() internal {
    (Constants.VaultState memory S, uint256 deltaUsbAmount) = this.calcDeltaUsbForPtyPoolBuyLow(settings, protocol.usbToken(), address(ptyPoolBuyLow));
    if (deltaUsbAmount == 0) {
      return;
    }

    uint256 deltaAssetAmount = deltaUsbAmount.mul(10 ** S.P_ETH_DECIMALS).div(S.P_ETH);
    tokenPot.withdraw(address(ptyPoolBuyLow), _assetToken, deltaAssetAmount);
    // console.log('_ptyPoolMatchBelowAARS, deltaUsbAmount: %s, deltaAssetAmount: %s', deltaUsbAmount, deltaAssetAmount);

    uint256 usbBurnShares = IUsb(_usbToken).burn(address(ptyPoolBuyLow), deltaUsbAmount);
    _usbTotalSupply = _usbTotalSupply.sub(deltaUsbAmount);
    emit UsbBurned(address(ptyPoolBuyLow), deltaUsbAmount, usbBurnShares, S.P_ETH, S.P_ETH_DECIMALS);

    ptyPoolBuyLow.notifyBuyLowTriggered(deltaAssetAmount);
  }

  function _ptyPoolMatchAboveAARU() internal {
    (Constants.VaultState memory S, uint256 deltaAssetAmount) = this.calcDeltaAssetForPtyPoolSellHigh(settings, address(ptyPoolSellHigh));
    if (deltaAssetAmount == 0) {
      return;
    }

    uint256 deltaUsbAmount = deltaAssetAmount.mul(S.P_ETH).div(10 ** S.P_ETH_DECIMALS);
    uint256 usbSharesAmount = IUsb(_usbToken).mint(address(ptyPoolSellHigh), deltaUsbAmount);
    _usbTotalSupply = _usbTotalSupply.add(deltaUsbAmount);
    emit UsbMinted(_msgSender(), deltaAssetAmount, deltaUsbAmount, usbSharesAmount, S.P_ETH, S.P_ETH_DECIMALS);

    // console.log('_ptyPoolMatchAboveAARU, deltaUsbAmount: %s, deltaAssetAmount: %s', deltaUsbAmount, deltaAssetAmount);

    ptyPoolSellHigh.notifySellHighTriggered(deltaAssetAmount, usbSharesAmount, address(tokenPot));
  }

  function _doSettleYields(uint256 yieldsBaseAssetAmount) internal {
    (uint256 usbOutAmount, uint256 marginTokenOutAmount) = this.calcSettleYields(settings, yieldsBaseAssetAmount, _lastYieldsSettlementTime);

    if (usbOutAmount > 0) {
      IUsb(_usbToken).rebase(usbOutAmount);
      _usbTotalSupply = _usbTotalSupply.add(usbOutAmount);
    }

    if (marginTokenOutAmount > 0) {
      uint256 toPtyPoolBuyLow = marginTokenOutAmount.mul(
        settings.vaultParamValue(address(this), "PtyPoolBuyLowMarginYieldsRate")
      ).div(10 ** settings.decimals());
      _accruedStakingYieldsForPtyPoolBuyLow = _accruedStakingYieldsForPtyPoolBuyLow.add(toPtyPoolBuyLow);
      uint256 toPtyPoolSellHigh = marginTokenOutAmount.sub(toPtyPoolBuyLow);
      _accruedMatchingYieldsForPtyPoolSellHigh = _accruedMatchingYieldsForPtyPoolSellHigh.add(toPtyPoolSellHigh);
    }

    if (_accruedStakingYieldsForPtyPoolBuyLow > 0 && ptyPoolBuyLow.totalStakingShares() > 0) {
      IMarginToken(_marginToken).mint(address(this), _accruedStakingYieldsForPtyPoolBuyLow);
      TokensTransfer.transferTokens(_marginToken, address(this), address(ptyPoolBuyLow), _accruedStakingYieldsForPtyPoolBuyLow);
      ptyPoolBuyLow.addStakingYields(_accruedStakingYieldsForPtyPoolBuyLow);
      _accruedStakingYieldsForPtyPoolBuyLow = 0;
    }

    if (_accruedMatchingYieldsForPtyPoolSellHigh > 0 && ptyPoolSellHigh.totalStakingShares() > 0) {
      IMarginToken(_marginToken).mint(address(this), _accruedMatchingYieldsForPtyPoolSellHigh);
      TokensTransfer.transferTokens(_marginToken, address(this), address(ptyPoolSellHigh), _accruedMatchingYieldsForPtyPoolSellHigh);
      ptyPoolSellHigh.addMatchingYields(_accruedMatchingYieldsForPtyPoolSellHigh);
      _accruedMatchingYieldsForPtyPoolSellHigh = 0;
    }

    if (usbOutAmount > 0 || marginTokenOutAmount > 0) {
      emit YieldsSettlement(usbOutAmount, marginTokenOutAmount);
    }
  }

  function _assetTokenPrice() internal view returns (uint256, uint256) {
    return (priceFeed.latestPrice(), priceFeed.decimals());
  }

  /* ============== MODIFIERS =============== */

  modifier whenMintNotPaused() {
    require(!_mintPaused, "Mint paused");
    _;
  }

  modifier whenRedeemNotPaused() {
    require(!_redeemPaused, "Redeem paused");
    _;
  }

  modifier whenUsbToMarginTokensNotPaused() {
    require(!_usbToMarginTokensPaused, "USB to Margin Tokens paused");
    _;
  }

  modifier noneZeroValue(uint256 value) {
    require(value > 0, "Value must be greater than 0");
    _;
  }

  modifier validMsgValue(uint256 value) {
    if (_assetToken == Constants.NATIVE_TOKEN) {
      require(msg.value == value, "Invalid msg value");
    }
    else {
      require(msg.value == 0, "msg.value should be 0");
    }
    _;
  }

  modifier noneZeroAddress(address addr) {
    require(addr != address(0), "Zero address detected");
    _;
  }

  modifier onlyOwnerOrProtocol() {
    require(_msgSender() == address(protocol) || _msgSender() == owner());
    _;
  }

  function _updateStateOnUserAction(uint256 previousAAR, uint256 afterAAR) internal {
    (uint256 AART, uint256 AARS, uint256 AARU, uint256 AARC) = this.getParamAARs(settings);
    if (afterAAR > AARU) {
      _vaultMode = Constants.VaultMode.AdjustmentAboveAARU;
      _aarBelowSafeLineTime = 0;
    }
    else if (afterAAR < AARS) {
      _vaultMode = Constants.VaultMode.AdjustmentBelowAARS;
      if (previousAAR >= AARS) {
        _aarBelowSafeLineTime = block.timestamp;
      }
    }
    else if ((previousAAR < AART && afterAAR >= AART) || (previousAAR > AART && afterAAR <= AART)) {
      // else if ((previousAAR < AARS && afterAAR >= AART) || (previousAAR > AARU && afterAAR <= AART)) {
      // bool lastIsAdjustment = _vaultMode != Constants.VaultMode.Stability;
      if (_vaultMode != Constants.VaultMode.Stability) {
        _vaultMode = Constants.VaultMode.Stability;
        _aarBelowSafeLineTime = 0;
      }
    }

    if (previousAAR >= AARC && afterAAR < AARC) {
      _aarBelowCircuitBreakerLineTime = block.timestamp;
    }
    else if (previousAAR < AARC && afterAAR >= AARC) {
      _aarBelowCircuitBreakerLineTime = 0;
    }
  }

  modifier onUserAction(bool settleYields) {
    if (_vaultMode == Constants.VaultMode.Empty) {
      _vaultMode = Constants.VaultMode.Stability;
    }
    uint256 yieldsBaseAssetAmount = assetBalance();

    _;

    if (settleYields) {
      if (_lastYieldsSettlementTime != 0) {
        _doSettleYields(yieldsBaseAssetAmount);
      }
      _lastYieldsSettlementTime = block.timestamp;
    }

    uint256 afterAAR = this.AAR();
    _updateStateOnUserAction(_previousAAR, afterAAR);

    if (afterAAR < paramValue("AARS")) {
      require(ptyPoolBuyLow != IPtyPool(address(0)), "PtyPoolBuyLow not set");
      uint256 minUsbAmount = paramValue("PtyPoolMinUsbAmount").mul(10 ** ((IUsb(_usbToken).decimals() - settings.decimals())));
      if (ptyPoolBuyLow.totalStakingBalance() > minUsbAmount) {
        _ptyPoolMatchBelowAARS();
        _updateStateOnUserAction(afterAAR, this.AAR());
      }
    }
    else if (afterAAR > paramValue("AARU")) {
      require(ptyPoolSellHigh != IPtyPool(address(0)), "PtyPoolSellHigh not set");
      uint256 minAssetAmount = this.calcPtyPoolMinAssetAmount(settings);
      if (ptyPoolSellHigh.totalStakingBalance() > minAssetAmount) {
        _ptyPoolMatchAboveAARU();
        _updateStateOnUserAction(afterAAR, this.AAR());
      }
    }

    _previousAAR = this.AAR();
  }

  /* =============== EVENTS ============= */

  event MintPaused();
  event MintUnpaused();
  event RedeemPaused();
  event RedeemUnpaused();
  event UsbToMarginTokensPaused();
  event UsbToMarginTokensUnpaused();

  event UsbMinted(address indexed user, uint256 assetTokenAmount, uint256 usbTokenAmount, uint256 usbSharesAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  event MarginTokenMinted(address indexed user, uint256 assetTokenAmount, uint256 marginTokenAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  
  event UsbBurned(address indexed user, uint256 usbTokenAmount, uint256 usbSharesAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  event MarginTokenBurned(address indexed user, uint256 marginTokenAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  
  event AssetRedeemedWithPairs(address indexed user, uint256 usbAmount, uint256 marginTokenAmount, uint256 assetAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  event AssetRedeemedWithUSB(address indexed user, uint256 usbAmount, uint256 assetAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  event AssetRedeemedWithMarginToken(address indexed user, uint256 marginTokenAmount, uint256 assetAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);
  event UsbToMarginTokens(address indexed user, uint256 usbAmount, uint256 marginTokenAmount, uint256 assetTokenPrice, uint256 assetTokenPriceDecimals);

  event YieldsSettlement(uint256 usbYieldsAmount, uint256 marginTokenYieldsAmount);
}