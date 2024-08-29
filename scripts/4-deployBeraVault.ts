import * as _ from "lodash";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import dotenv from "dotenv";
import { ethers } from "hardhat";
import { deployContract } from "./hutils";
import { Vault__factory, ZooProtocol__factory } from "../typechain";

dotenv.config();

const protocolAddress = "0xC816c35f07a40021e15295229dDb5895c90179ef";
const protocolSettingsAddress = "0xa96Ffb41dfDe9b33aF3D233eaa05EB8B6798B477";
const vaultCalculatorAddress = "0x01af9e67C733D60078C645D715185f2Aa6eC50b8";

const assetsToken = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const assetsSymbol = "BERA";
const marginTokenName = "Zoo xBERA";
const marginTokenSymbol = "xBERA";

const chainlinkPriceFeed = "";

let deployer: SignerWithAddress;
const testers = [
  "0x956Cd653e87269b5984B8e1D2884E1C0b1b94442",
  "0xc97B447186c59A5Bb905cb193f15fC802eF3D543",
  "0x1851CbB368C7c49B997064086dA94dBAD90eB9b5",
];

async function main() {
  const signers = await ethers.getSigners();
  deployer = signers[0];
  console.log(`Deployer: ${await deployer.getAddress()}, nonce: ${await deployer.getNonce()}`);

  const priceFeedName = assetsSymbol + "_PriceFeed";
  let priceFeedAddress;
  if (chainlinkPriceFeed) {
    priceFeedAddress = await deployContract("CommonPriceFeed", [chainlinkPriceFeed], priceFeedName);
  }
  else {
    priceFeedAddress = await deployContract("MockPriceFeed", [protocolAddress], priceFeedName);
    const mockPriceFeed = await ethers.getContractAt("MockPriceFeed", priceFeedAddress);
    for (let i = 0; i < _.size(testers); i++) {
      const tester = testers[i];
      const isTester = await mockPriceFeed.isTester(tester);
      if (isTester) {
        console.log(`${priceFeedName}: ${tester} is already a tester`);
      }
      else {
        const trans = await mockPriceFeed.connect(deployer).setTester(tester, true);
        await trans.wait();
        console.log(`${priceFeedName}: ${tester} is now a tester`);
      }
    }
  }

  const marginTokenAddress = await deployContract(
    "MarginToken",
    [
      protocolAddress,
      protocolSettingsAddress,
      marginTokenName,
      marginTokenSymbol,
    ],
    `${marginTokenSymbol}`
  );
  
  const marginToken = await ethers.getContractAt("MarginToken", marginTokenAddress);
  const vaultAddress = await deployContract(
    "Vault",
    [
      protocolAddress,
      protocolSettingsAddress,
      assetsToken,
      marginTokenAddress,
      priceFeedAddress,
    ],
    assetsSymbol + "_Vault",
    {
      libraries: {
        VaultCalculator: vaultCalculatorAddress,
      },
    }
  );

  const belowPoolAddress = await deployContract(
    "PtyPoolBuyLow",
    [
      protocolAddress,
      protocolSettingsAddress,
      vaultAddress,
      marginTokenAddress,
      assetsToken,
    ],
    `${assetsSymbol}_PtyPoolBuyLow`
  );
  const abovePoolAddress = await deployContract(
    "PtyPoolSellHigh",
    [
      protocolAddress,
      protocolSettingsAddress,
      vaultAddress,
      assetsToken,
      marginTokenAddress,
    ],
    `${assetsSymbol}_PtyPoolSellHigh`
  );

  let trans = await marginToken.connect(deployer).setVault(vaultAddress);
  await trans.wait();
  console.log(`Connect margin token to ${assetsSymbol} Vault`);

  const protocol = await ZooProtocol__factory.connect(protocolAddress, deployer);
  trans = await protocol.connect(deployer).addVault(vaultAddress);
  await trans.wait();
  console.log(`Add ${assetsSymbol} vault to Wand Protocol`);

  const vault = await Vault__factory.connect(vaultAddress, deployer);
  trans = await vault.connect(deployer).setPtyPools(belowPoolAddress, abovePoolAddress);
  await trans.wait();
  console.log(`Set ${assetsSymbol} Vault PtyPools`);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
