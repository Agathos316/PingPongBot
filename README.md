# Ping Pong Bot: Explainer document
A bot to respond to ping events with calls to the pong method, of smart contract 0xA7F42ff7433cB268dD7D59be62b00c30dEd28d3D (Sepolia)

**Initialization:**
* The bot checks whether the current bot instance with the given account address is the first time the bot has run on that account.
* If the bot has previously run on the given account:
  * The bot checks for any pending transaction left after the previous bot instance ended, and proceeds to manage this transaction until confirmed.
  * The bot checks the block number at which the previous instance ended, and looks for ping events that were missed during the bot’s ‘down time’ (in between active instances).
  * If missed ping events are found, the bot adds their hashes to a transaction queue, in the order that the ping events occur.

**Protocol:**
* The bot listens for new block headers and updates the estimated maximum gas price every block.
* The bot adds ping event hashes (either new ping events, or ping missed events) to a single transaction queue.
* The bot processes one transaction from the queue at a time to avoid conflicts or duplicate submissions:
  * A pending transaction is monitored until it is confirmed.
  * A transaction is removed from the transaction queue only once it is confirmed.
  * Network gas prices continue to be updated every block. If network gas prices increase too much, preventing a transaction from being mined, the bot resubmits the transaction at a higher gas price (using the same nonce as the original pending transaction).
* At each new block, the bot checks whether any blocks were missed (by checking for contiguous block numbers). If blocks were missed, the missed blocks are searched for any ping events. Missed ping events are added to the transaction queue.
* The transaction queue, current block number, and any pending transaction details are written to storage in real-time, to ensure that if the bot stops, it can restart with all the necessary information to perform the full initialization described at the start of this document. This ensures that no ping events are missed once the bot is running again.
