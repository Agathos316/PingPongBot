# Ping Pong Bot: Explainer document
A bot to respond to ping events with calls to the pong method, of smart contract [0xA7F42ff7433cB268dD7D59be62b00c30dEd28d3D](https://sepolia.etherscan.io/txs?a=0xa7f42ff7433cb268dd7d59be62b00c30ded28d3d) (Sepolia)

## Initialization
* Upon start, the bot immediately listens for Ping events and for new block headers.
* The bot checks whether the current bot instance with the given account address is the first time the bot has run on that account.
* If the bot has previously run on the given account:
  * The bot checks for any pending transaction left after the previous bot instance ended, and proceeds to manage this transaction until confirmed.
  * The bot checks the block number at which the previous instance ended, and looks for ping events that were missed during the bot’s downtime (i.e. in between active bot instances).
  * If missed ping events are found, the bot adds their hashes to a transaction queue, in the order that the ping events occurred.

## Protocol
* The bot listens for new block headers and updates the estimated maximum gas price every block.
* The bot adds ping event hashes to a single transaction queue.
* The bot processes one transaction from the queue at a time to avoid conflicts or duplicate submissions:
  * The gas price is set using the formula: $2$ $\times$ *Base Fee* $+$ *Aggresive Priority Fee*. This ensures the transaction remains marketable for at least six consecutive blocks that are 100% full (see [this article](https://www.blocknative.com/blog/eip-1559-fees#3)).
  * A pending transaction is monitored until it is confirmed.
  * A transaction is removed from the transaction queue only once it is confirmed.
  * Network gas prices continue to be updated every block. If network gas prices increase too much, preventing a transaction from being mined, the bot resubmits the transaction at a higher gas price (using the same nonce as the original pending transaction).

## Error Management
### Safe-Restart
The transaction queue, current block number, and any pending transaction hash are written to storage in real-time, to ensure that if the bot stops, it can restart with all the necessary information to perform the full initialization described above. The only situation where a restart would result in unpredictable behaviour is if the bot stops within the narrow window between a transaction being submitted by the bot and a transaction hash being provided by the mempool. Tracking a transaction before a hash has been provided is a complex task, and beyond the scope of this bot. However, the time window of concern is typically extremely short and presents little risk.

### Network Outage Handling and Rate-Limiting Prevention
* At each new block, the bot checks whether any blocks were missed by checking for contiguous block numbers. If blocks were missed, the missed blocks are searched for ping events. Missed ping events are added to the transaction queue. This is a fail-safe in case of downtime or rate-limiting in the Infura block listener.
* Infura is queried for gas price estimates only every new block. Keeping such queries to only occur with each new block help guards against being rate limited by Infura.
* If gas price queries are rate limited, or fail for any reason, processing of new transactions pauses until gas price estimates resume.
* Querying missed blocks is done through the Web3 Ethereum API to avoid adding to Infura traffic, thus lowering the risk of being rate-limited by Infura.

### Transaction Error Management
* The bot does not allow a new transaction to proceed until the previous transaction has been mined. This helps guard against conflicting nonces, or transactions being frozen in the mempool by prior unmined transactions. This also applies to when there is a new instance of the bot (i.e. whenever it is restarted after a failure). As explained in __*Initialization*__ above, the bot first checks for a still-pending transaction from an earlier instance of the bot. If there is a still-pending transaction, the bot will continue to listen for new blocks and ping events but will not execute any further transactions until the pending transaction is confirmed.
* If a transaction errors in the network and fails to process, the bot aborts processing the transaction queue entirely, waits for the next block in order to allow necessary parameters to refresh, and attempts to restart processing the transaction queue anew. This will successfully handle the plausible transaction errors that might be present (such as a competing nonce, out of gas, etc.). As the nonce calculator only looks at confirmed transactions, an errored transaction will be resubmitted with the same nonce whenever processing of the transaction queue succesffully resumes.

### Missed Ping Prevention
As described in __*Protocol*__ above, checks are made for contiguous block numbers, and for blocks missed between successive bot instances on the same account. Missed blocks are queried for ping events and necessary pong responses are added to the transaction queue.

### Duplicate Pong Prevention
* Duplicate pong responses are avoided by implementing a strict transaction queue, allowing only one transaction pending at a time. Only failed or stuck transactions are resubmitted (with the same nonce to prevent duplicate pongs), else no further transacting occurs until the pending transaction is confirmed.
* The transaction queue is immediately updated upon transaction confirmation, helping ensure that no transaction is processed twice.
* Every time the transaction queue changes, or a new transaction is pending, this information is immediately written to local storage to prevent the bot submitting duplicate pongs if it stops and restarts.
