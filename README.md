# Ping Pong Bot: Developer Reference
A bot to respond to ping events with calls to the pong method of the PingPong smart contract at [0xA7F42ff7433cB268dD7D59be62b00c30dEd28d3D](https://sepolia.etherscan.io/txs?a=0xa7f42ff7433cb268dd7d59be62b00c30ded28d3d) (Sepolia)

_PingPongBot.js_ is the more user-friendly node.js code. _PingPongBot (minimal).js_ is a stripped-down version with 30% less code by removing most console output and code for testing, keeping only the core functions for the bot to run.

## Initialization
* Upon starting, the bot immediately listens for Ping events and for new block headers.
* The bot checks whether the current bot instance with the given account address is the first time the bot has run on that account.
* If the bot has previously run on the given account:
  * The bot checks for any pending transaction left after the previous bot instance ended, and proceeds to manage this transaction until confirmed.
  * The bot checks the block number at which the previous bot instance ended, and looks for ping events that were missed during the bot’s downtime (i.e. in between active bot instances).
  * If missed ping events are found, the bot adds their hashes to a transaction queue, in the order that the ping events occurred.

## Protocol
* The bot listens for new block headers.
* The bot adds ping event hashes to a single future transaction queue.
* The bot processes one transaction from the queue at a time, waiting until it is confirmed before initiating a new transaction:
  * Gas prices for new transactions are set using the formula: $2$ $\times$ *Base Fee* $+$ *Aggresive Priority Fee*. This ensures transactions remain marketable for at least six consecutive blocks that are 100% full (see [this article](https://www.blocknative.com/blog/eip-1559-fees#3)).
  * A pending transaction is monitored until it is confirmed.
  * A ping hash is removed from the queue only once its pong transaction is confirmed.
  * Network gas prices continue to be updated every block while a transaction is pending. If network gas prices increase too much, preventing a transaction from being mined, the bot resubmits the transaction at an updated gas price using the formula above (and using the same nonce as the original pending transaction).
* Every 2160 blocks (approx. 8 hours), the bot checks for any ping events that were not responded to, and adds their hashes to the transaction queue.

## Error Management
### Safe-Restart
The transaction queue, current block number, and any pending transaction hash are written to storage in real-time, to ensure that if the bot stops, it can restart with all the necessary information to perform the full initialization described above.

### Rate-Limiting Prevention and Network Outage Handling
* Infura is queried for gas price estimates because it allows deduction of the base fee and priority fee. (The Web3 Ethereum library does not allow this level of specificity.) Infura is queried for this only when a transaction is being created, or every block while a transaction is pending. This helps guard against being rate limited by Infura.
* If gas price queries are rate limited, or fail for any reason, executing of new transactions pauses until gas price estimates resume.
* At each new block, the bot checks whether any blocks were missed by checking for contiguous block numbers. If blocks were missed, the missed blocks are searched for ping events. Missed ping events will have their hashes added to the transaction queue. This is a fail-safe mechanism in case of downtime or rate-limiting in the Infura block listener. (Infura is used for new block listening, as it fires new block events in a more timely fashion than the Web3 library.)
* Querying missed blocks is done through the Web3 Ethereum API to avoid adding more bot traffic to the Infura node, thus lowering the risk of being rate-limited by Infura.
* Ping hashes are only removed from the transaction queue when their pong transaction is executed and confirmed. If there is a network outage causing a transaction submission to fail, the transaction queue remains unchanged, and the bot will simply try again, or successfully execute the transaction when the bot restarts.
* Every 2160 blocks (approximately 8 hours) the bot checks for any ping events that were not responded to, adding their hashes to the transaction queue. If this fails, the failure is logged and the next 2160-block mark will check the previous 2 $\times$ 2160 $=$ 4320 blocks, and so on until a successful historical validation is made. This regular check is to handle issues on the deployment server and network problems. An interval of 2160 blocks is chosen to sufficiently exceed a maximum estimated portion of the day that might get rate-limited (a third of a day), yet not be so large that the potential delay in finding missed ping events becomes unacceptably long.
* In the case of a network outage, the bot may have submitted a transaction but not receive notification that it has been mined. This may be detrimental because of the use of a strict transaction queue (i.e. future transactions will not be processed). If a transaction appears to be pending for a long time (15 or more blocks), the bot will begin probing the transaction status with each new block (in addition to also listening for the network to trigger a confirmation event). In this way, a confirmed transaction is sure to be identified as such, even if the bot does not receive the confirmation event associated with the `sendSignedTransaction()` method.

### Transaction Error Management
* The bot does not allow a new transaction to proceed until the previous transaction has been mined. This helps guard against conflicting nonces, or transactions being frozen in the mempool by prior unmined transactions.
* The above rule is applied even when the bot is restarted (e.g. after a failure). As explained under the __*Initialization*__ heading, upon starting, the bot first checks for a still-pending transaction from an earlier instance of the bot. If there is a still-pending transaction, the bot will continue to listen for new blocks and ping events but will not execute any further transactions until the pending transaction is confirmed.
* As mentioned, a transaction is unlikely to be stuck because the bot constantly compares the submitted gas price with the current gas price, and will resubmit a pending transaction (with the same nonce) if the current gas price rises too high.
* If a transaction errors from the network (not from the bot's code), the bot aborts processing the transaction queue entirely. It waits for the next block, as this will allow necessary parameters to refresh, which then allows the bot to restart processing the transaction queue anew. This method successfully mitigates the plausible transaction errors that might be present (such as a competing nonce, out of gas, etc.).

### Missed Ping Prevention
As described under the __*Protocol*__ heading, any blocks that are missed (prior to, or during a bot instance) are checked for ping events, and the transaction queue is updated accordingly. Every 270 blocks, a search is also made for missed ping events.

### Duplicate Pong Prevention
* Duplicate pong responses are avoided by implementing a strict transaction queue, allowing only one transaction pending at a time. Only failed or stuck transactions are resubmitted (with the same nonce to prevent duplicate pongs), else no further transacting occurs until the pending transaction is confirmed.
* The nonce calculator only looks at confirmed transactions, ensuring that an errored or pending transaction will be resubmitted with the same nonce, preventing duplicate or stuck transactions.
* A ping hash is immediately removed from the transaction queue as soon as its transaction is mined, helping ensure that no ping hash in the queue is processed twice.
* Local storage is immediately updated every time the transaction queue changes or a new transaction is pending. If the bot stops and restarts, the up-to-date information in local storage will ensure the bot does not duplicate a pong transaction.
