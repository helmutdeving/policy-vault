// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Helper contract for testing calldata forwarding. Not deployed in production.
contract TestReceiver {
    bool public pinged;
    uint256 public lastValue;

    function ping() external payable {
        pinged = true;
        lastValue = msg.value;
    }

    receive() external payable {
        lastValue = msg.value;
    }
}
