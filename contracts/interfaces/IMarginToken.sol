// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMarginToken is IERC20 {

  function mint(address to, uint256 amount) external;

  function burn(address account, uint256 amount) external;

}