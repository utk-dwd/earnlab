// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Development oracle — accepts any proof signed by the oracle owner.
///         In production, replace with a TEE attestation verifier or ZKP verifier.
interface IOracle {
    function verifyProof(bytes calldata proof) external view returns (bool);
}

contract MockOracle is IOracle, Ownable {
    // proof = abi.encode(bytes32 nonce, bytes signature_by_owner)
    mapping(bytes32 => bool) private _usedNonces;

    constructor() Ownable(msg.sender) {}

    /// @notice Verifies proof = abi.encodePacked(nonce32, ownerSig65)
    function verifyProof(bytes calldata proof) external view override returns (bool) {
        if (proof.length < 97) return false; // 32 nonce + 65 sig
        bytes32 nonce = bytes32(proof[:32]);
        if (_usedNonces[nonce]) return false;

        bytes memory sig = proof[32:97];
        bytes32 msgHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", nonce));
        address signer = _recoverSigner(msgHash, sig);
        return signer == owner();
    }

    /// @notice Consume a nonce after use (called by ERC7857iNFT on valid transfer)
    function consumeNonce(bytes32 nonce) external onlyOwner {
        _usedNonces[nonce] = true;
    }

    function _recoverSigner(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "Invalid sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
