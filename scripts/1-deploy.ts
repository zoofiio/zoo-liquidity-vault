import * as _ from "lodash";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { FactoryOptions } from "@nomicfoundation/hardhat-ethers/types";
import dotenv from "dotenv";
import { ethers } from "hardhat";
import { deployContract } from "./hutils";

dotenv.config();

const treasuryAddress = '0xC73ce0c5e473E68058298D9163296BebAC2b729C';
const ibgtPriceFeed = '';

// https://docs.infrared.finance/testnet/deployments#contracts
const vaults = [
  {
    assetsToken: "0x46eFC86F0D7455F135CC9df501673739d513E982",
    assetsSymbol: "iBGT",
    marginTokenName: "Zoo xiBGT",
    marginTokenSymbol: "xiBGT",
    chainlinkPriceFeed: ibgtPriceFeed,
  },
];

const stableVaults: any[] = [
  
];
let deployer: SignerWithAddress;

const testers: any[] = [
  "0x956Cd653e87269b5984B8e1D2884E1C0b1b94442",
  "0xc97B447186c59A5Bb905cb193f15fC802eF3D543",
  "0x1851CbB368C7c49B997064086dA94dBAD90eB9b5"
];


async function deployValut(
  vault: (typeof vaults)[0],
  settingsAddress: string,
  protocolAddress: string,
  factoryOptions?: FactoryOptions
) {
  const priceFeedName = vault.assetsSymbol + "_PriceFeed";

  let priceFeedAddress;
  if (vault.chainlinkPriceFeed) {
    priceFeedAddress = await deployContract("CommonPriceFeed", [vault.chainlinkPriceFeed], priceFeedName);
  } 
  else {
    priceFeedAddress = await deployContract("MockPriceFeed", [protocolAddress], priceFeedName);
    const mockPriceFeed = await ethers.getContractAt("MockPriceFeed", priceFeedAddress);
    for (let i = 0; i < _.size(testers); i++) {
      const tester = testers[i];
      const isTester = await mockPriceFeed.isTester(tester);
      if (isTester) {
        console.log(`${priceFeedName}: ${tester} is already a tester`);
      } else {
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
      settingsAddress,
      vault.marginTokenName,
      vault.marginTokenSymbol,
    ],
    `${vault.marginTokenSymbol}`
  );

  const marginToken = await ethers.getContractAt("MarginToken", marginTokenAddress);
  const vaultAddress = await deployContract(
    "Vault",
    [
      protocolAddress,
      settingsAddress,
      vault.assetsToken,
      marginTokenAddress,
      priceFeedAddress,
    ],
    vault.assetsSymbol + "_Vault",
    factoryOptions
  );
  const Vault = await ethers.getContractAt("Vault", vaultAddress);
  // below buy pool
  const belowPoolAddress = await deployContract(
    "PtyPoolBuyLow",
    [
      protocolAddress,
      settingsAddress,
      vaultAddress,
      marginTokenAddress,
      vault.assetsToken,
    ],
    `${vault.assetsSymbol}_PtyPoolBuyLow`
  );
  // above sell pool
  const abovePoolAddress = await deployContract(
    "PtyPoolSellHigh",
    [
      protocolAddress,
      settingsAddress,
      vaultAddress,
      vault.assetsToken,
      marginTokenAddress,
    ],
    `${vault.assetsSymbol}_PtyPoolSellHigh`
  );

  // setPtyPools
  let trans = await Vault.connect(deployer).setPtyPools(belowPoolAddress, abovePoolAddress);
  await trans.wait();
  console.log(`Set ${vault.assetsSymbol} Vault PtyPools`);

  // marginToken setVault
  trans = await marginToken.connect(deployer).setVault(vaultAddress);
  await trans.wait();
  console.log(`Connect margin token to ${vault.assetsSymbol} Vault`);

  return vaultAddress;
}

async function deployStableValut(
  vault: (typeof stableVaults)[0],
  settingsAddress: string,
  protocolAddress: string,
  factoryOptions?: FactoryOptions
) {
  const priceFeedName = vault.assetsSymbol + "_PriceFeed";

  let priceFeedAddress;
  if (vault.chainlinkPriceFeed) {
    priceFeedAddress = await deployContract(
      "CommonPriceFeed",
      [vault.chainlinkPriceFeed],
      priceFeedName
    );
  }
  else {
    priceFeedAddress = await deployContract("MockPriceFeed", [protocolAddress], priceFeedName);
    const mockPriceFeed = await ethers.getContractAt("MockPriceFeed", priceFeedAddress);
    for (let i = 0; i < _.size(testers); i++) {
      const tester = testers[i];
      const isTester = await mockPriceFeed.isTester(tester);
      if (isTester) {
        console.log(`${priceFeedName}: ${tester} is already a tester`);
      } else {
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
      settingsAddress,
      vault.marginTokenName,
      vault.marginTokenSymbol,
    ],
    `${vault.marginTokenSymbol}`
  );
  const marginToken = await ethers.getContractAt("MarginToken", marginTokenAddress);
  const vaultAddress = await deployContract(
    "StableVault",
    [
      protocolAddress,
      settingsAddress,
      vault.assetsToken,
      marginTokenAddress,
      priceFeedAddress,
    ],
    vault.assetsSymbol + "_StableVault",
    factoryOptions
  );

  let trans = await marginToken.connect(deployer).setVault(vaultAddress);
  await trans.wait();
  console.log(`Connect margin token to ${vault.assetsSymbol} Vault`);

  return vaultAddress;
}

async function main() {
  const signers = await ethers.getSigners();
  deployer = signers[0];
  const nonce = await deployer.getNonce();
  console.log("nonce:", nonce);

  // Deploy Protocol
  const protocolAddress = await deployContract("ZooProtocol", []);
  const protocol = await ethers.getContractAt("ZooProtocol", protocolAddress);

  //  Deploy Protocol core contracts
  const protocolSettingsAddress = await deployContract("ProtocolSettings", [protocolAddress, treasuryAddress]);
  const settings = await ethers.getContractAt("ProtocolSettings", protocolSettingsAddress);

  // Deploy Usd
  const usdAddress = await deployContract("Usd", [protocolAddress, await settings.getAddress()]);
  const Usd = await ethers.getContractAt("Usd", usdAddress);

  // initProtocal Usd
  if (!(await protocol.initialized())) {
    await protocol
      .connect(deployer)
      .initialize(await Usd.getAddress())
      .then((tx) => tx.wait(1));
  }
  console.log(`Initialized ZooProtocol with $zUSD token`);

  const vaultCalculatorAddress = await deployContract("VaultCalculator", []);
  for (const vc of vaults) {
    const ethVaultAddress = await deployValut(vc, protocolSettingsAddress, protocolAddress, {
      libraries: {
        VaultCalculator: vaultCalculatorAddress,
      },
    });
    // protocal Add Vault
    if (!(await protocol.isVault(ethVaultAddress)))
      await protocol
        .connect(deployer)
        .addVault(ethVaultAddress)
        .then((tx) => tx.wait(1));
  }

  const stableVaultCalculatorAddress = await deployContract("StableVaultCalculator", []);
  for (const vc of stableVaults) {
    const usdbVaultAddress = await deployStableValut(vc, protocolSettingsAddress, protocolAddress, {
      libraries: {
        StableVaultCalculator: stableVaultCalculatorAddress,
      },
    });
    // protocal Add Vault
    if (!(await protocol.isVault(usdbVaultAddress)))
      await protocol
        .connect(deployer)
        .addVault(usdbVaultAddress)
        .then((tx) => tx.wait(1));

    // set Y to 2.0%
    await settings.connect(deployer).updateVaultParamValue(usdbVaultAddress, ethers.encodeBytes32String("Y"), 2 * 10 ** 8);
    console.log(`Set USDB vault Y to 2.0%`);

    // set AARS to 115%
    await settings.connect(deployer).updateVaultParamValue(usdbVaultAddress, ethers.encodeBytes32String("AARS"), 115 * 10 ** 8);
    console.log(`Set USDB vault AARS to 115%`);
  }
  await deployContract("VaultQuery", [], "VaultQuery", {
    libraries: {
      VaultCalculator: vaultCalculatorAddress,
      StableVaultCalculator: stableVaultCalculatorAddress,
    },
  });
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
