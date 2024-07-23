// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

import "../tokens/Usb.sol";

contract MockUsb is Usb {
  constructor(address _protocol, address _settings) Usb(_protocol, _settings) {}

  modifier onlyVault() override {
    // _checkOwner();
    _;
  }
}