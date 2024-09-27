import { ethers } from "hardhat";
import { deployContract } from "./hutils";
import { BexPriceFeed__factory } from "../typechain";

async function main() {
  const [deployer] = await ethers.getSigners();
  const crocquery = "0x8685CE9Db06D40CBa73e3d09e6868FE476B5dC89";
  const honey = "0x0E4aaF1351de4c0264C5c7056Ef3777b41BD8e03";
  const lps = [["HONEY-WBERA", "0xd28d852cbcc68DCEC922f6d5C7a8185dBaa104B7"]];
  for (const lp of lps) {
    const [name, lpAddress] = lp;
    const bexPriceFeedAddress = await deployContract("BexPriceFeed", [crocquery, lpAddress, honey], `${name.split("-")[1]}_BexPriceFeed`);
    const price = await BexPriceFeed__factory.connect(bexPriceFeedAddress, ethers.provider).latestPrice();
    console.info("name:", ethers.formatUnits(price, 8));
  }
}
main().catch(console.error);
