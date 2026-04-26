// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract EarnlabMarketplace is ReentrancyGuard, Ownable {
    uint256 public constant FEE_BPS = 250;

    struct Listing { address seller; uint256 tokenId; uint256 price; bool isActive; }
    struct Lease { address lessor; address lessee; uint256 tokenId; uint256 pricePerEpoch; uint256 expiresAt; bool isActive; }

    IERC721 public immutable inftContract;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => Lease) public leases;

    event Listed(uint256 indexed tokenId, address indexed seller, uint256 price);
    event Sold(uint256 indexed tokenId, address indexed buyer, uint256 price);
    event Leased(uint256 indexed tokenId, address indexed lessee, uint256 epochs);

    constructor(address inftAddress) Ownable(msg.sender) { inftContract = IERC721(inftAddress); }

    function list(uint256 tokenId, uint256 price) external {
        require(inftContract.ownerOf(tokenId) == msg.sender, "Not owner");
        require(price > 0, "Price must be > 0");
        inftContract.transferFrom(msg.sender, address(this), tokenId);
        listings[tokenId] = Listing(msg.sender, tokenId, price, true);
        emit Listed(tokenId, msg.sender, price);
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        Listing storage listing = listings[tokenId];
        require(listing.isActive, "Not listed");
        require(msg.value >= listing.price, "Insufficient payment");
        listing.isActive = false;
        uint256 fee = (listing.price * FEE_BPS) / 10_000;
        inftContract.transferFrom(address(this), msg.sender, tokenId);
        payable(listing.seller).transfer(listing.price - fee);
        payable(owner()).transfer(fee);
        emit Sold(tokenId, msg.sender, listing.price);
    }

    function leaseAgent(uint256 tokenId, uint256 epochs, uint256 pricePerEpoch) external payable nonReentrant {
        require(msg.value >= pricePerEpoch * epochs, "Insufficient lease payment");
        leases[tokenId] = Lease({ lessor: inftContract.ownerOf(tokenId), lessee: msg.sender, tokenId: tokenId, pricePerEpoch: pricePerEpoch, expiresAt: block.timestamp + (epochs * 1 days), isActive: true });
        emit Leased(tokenId, msg.sender, epochs);
    }

    function withdrawFees() external onlyOwner { payable(owner()).transfer(address(this).balance); }
}
