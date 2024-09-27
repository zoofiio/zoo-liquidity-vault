// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.18;

import "../interfaces/IPriceFeed.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ILP is IERC20 {
    function poolType() external view returns (uint256);

    function baseToken() external view returns (address);

    function quoteToken() external view returns (address);
}

interface CrocQuery {
    function queryPrice(
        address base,
        address quote,
        uint256 poolType
    ) external view returns (uint128);
}

contract BexPriceFeed is IPriceFeed {
    CrocQuery cq;
    ILP mlp;

    constructor(address crocquery, address lp, address honey) {
        cq = CrocQuery(crocquery);
        mlp = ILP(lp);
        require(mlp.baseToken() == honey, "lp error");
    }

    function decimals() external pure override returns (uint8) {
        return 8;
    }

    function latestPrice() external view override returns (uint256) {
        uint128 price = cq.queryPrice(
            mlp.baseToken(),
            mlp.quoteToken(),
            mlp.poolType()
        );
        return ((uint256(price) * 1e8) >> 64) ** 2 / 1e8;
    }
}
