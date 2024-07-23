import * as _ from 'lodash';
import dotenv from "dotenv";
import { ethers } from "hardhat";
import { power } from '../test/utils';
import {
  ProtocolSettings__factory,
  Usb__factory,
  Vault,
  Vault__factory,
  StableVault,
  ERC20__factory,
  CommonPriceFeed__factory,
  MockPriceFeed__factory,
  VaultQuery,
  VaultQuery__factory,
  MarginToken__factory,
} from '../typechain';

dotenv.config();

const privateKey: string = process.env.DEPLOYER_KEY || "";

const nativeTokenAddress = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const gasPrice = ethers.parseUnits('3', 'gwei'); 
const provider = new ethers.JsonRpcProvider(`https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`);
const deployer = new ethers.Wallet(privateKey, provider);

const ethVaultAddress = '0xbB73d2E5E34FA72800d3670fb55ccb65c3B95F46';
const vaultQueryAddress = '0xe9457396a3BD40E06D6ff0a4bbeAB3E00510087e';

async function testEthVault() {
  const ethVault = Vault__factory.connect(ethVaultAddress, provider);

  // Mock price
  const mockedPrice = BigInt(3000) * (power(8));
  const mockPriceFeed = MockPriceFeed__factory.connect(await ethVault.priceFeed(), provider);
  let trans0 = await mockPriceFeed.connect(deployer).mockPrice(mockedPrice, {gasPrice});
  await trans0.wait();
  console.log(`Mocked price of $ETH: 3000`);

  const priceFeed = CommonPriceFeed__factory.connect(await ethVault.priceFeed(), provider);
  const price = await priceFeed.latestPrice();
  console.log(`Price of $ETH: ${ethers.formatUnits(price, await priceFeed.decimals())}`);

  const ethAmount = ethers.parseEther('0.1');
  let trans = await ethVault.connect(deployer).mintPairs(ethAmount, {value: ethAmount, gasPrice});
  await trans.wait();
  console.log(`Deposited ${ethers.formatEther(ethAmount)} $ETH to mint $ETHx`);

  const vaultQuery = VaultQuery__factory.connect(vaultQueryAddress, provider);
  await dumpVaultState(ethVault, vaultQuery);

  // Check $USB balance
  const usbToken = Usb__factory.connect(await ethVault.usbToken(), provider);
  let usbBalance = await usbToken.balanceOf(deployer.address);
  console.log(`$USB balance: ${ethers.formatUnits(usbBalance, 18)}`);

  // Check $ETHx balance
  const ethxToken = MarginToken__factory.connect(await ethVault.marginToken(), provider);
  let ethxBalance = await ethxToken.balanceOf(deployer.address);
  console.log(`$ETHx balance: ${ethers.formatUnits(ethxBalance, 18)}`);

  // Redeem 10 $USB
  const usbAmount = ethers.parseUnits('10', 18);
  const pairedEthxAmount = await vaultQuery.calcPairdMarginTokenAmount(await ethVault.getAddress(), usbAmount);
  console.log(`Redeem ${ethers.formatUnits(usbAmount, 18)} $USB, paired ${ethers.formatUnits(pairedEthxAmount, 18)} $ETHx`);
  trans = await ethVault.connect(deployer).redeemByPairsWithExpectedUsbAmount(usbAmount, {gasPrice});
  await trans.wait();
  usbBalance = await usbToken.balanceOf(deployer.address);
  console.log(`$USB balance: ${ethers.formatUnits(usbBalance, 18)}`);
  ethxBalance = await ethxToken.balanceOf(deployer.address);
  console.log(`$ETHx balance: ${ethers.formatUnits(ethxBalance, 18)}`);
}

async function dumpVaultState(vault: Vault | Vault | StableVault | StableVault, vaultQuery: VaultQuery | VaultQuery) {
  const settings = ProtocolSettings__factory.connect(await vault.settings(), provider);

  const assetTokenERC20 = ERC20__factory.connect(await vault.assetToken(), provider);
  const assetSymbol = (await vault.assetToken() == nativeTokenAddress) ? 'ETH' : await assetTokenERC20.symbol();
  const usbToken = Usb__factory.connect(await vault.usbToken(), provider);
  const marginToken = Usb__factory.connect(await vault.marginToken(), provider);

  const aar = await vaultQuery.AAR(await vault.getAddress());
  const AAR = (aar == ethers.MaxUint256) ? 'MaxUint256' : ethers.formatUnits(aar, await vault.AARDecimals());

  console.log(`$${assetSymbol} Vault:`);
  console.log(`  M_${assetSymbol}: ${ethers.formatUnits(await vault.assetBalance(), 18)}`);
  console.log(`  M_USB: ${ethers.formatUnits(await usbToken.totalSupply(), 18)}`);
  console.log(`  M_USB_${assetSymbol}: ${ethers.formatUnits(await vault.usbTotalSupply(), 18)}`);
  console.log(`  M_${assetSymbol}x: ${ethers.formatUnits(await marginToken.totalSupply(), 18)}`);
  console.log(`  AAR: ${AAR}`);
  console.log(`  APY: ${ethers.formatUnits(await vault.paramValue(ethers.encodeBytes32String('Y')), await settings.decimals())}`);
}

async function main() {
  await testEthVault();
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});