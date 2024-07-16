/**
 *  @title: Ping Pong bot.
 *  @author: Tim Mapperson
 *  @repo: https://github.com/Agathos316/
 */


/***************************************************
 * Import/Require necessary packages.
 */
// These lines make "require" available even though this file is of "type": "module".
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Bring in the necessary packages.
const { Web3 } = require('web3');
require('dotenv').config();
const storage = require('node-persist');
const axios = require('axios');


/***************************************************
 * Global variables
 */
// Variables.
let latestBlockNumber;
let web3_InfuraWS;
let contract;
let addressBotIsRunningWith;
let txQueue;
let pendingTxHash = null;
let pendingGasPriceGwei = null;
let pendingNonce = null;
let pendingPongData = null;
let pendingTxStartBlock = null;
let baseFeeGwei;
let safeMaxFeeGwei;
let firstLoadBlockNumber;
let blockReviewFailureCount = 1;
// Flags/State variables.
let BOT_STARTING = true;
let STATE_pendingTx = false;
let STATE_processingQueue = false;
let STATE_manualCheckInProgress = false;
let STATE_handlingConfirmedTx = false;
/* Persistent storage items to be managed:
    - addressBotIsRunningWith: the account address the bot is or was running with last.
    - firstLoadBlockNumber: the block number when the bot first started using the current account address.
    - lastCheckedBlockNumber: the block number most recently listened to for Ping events.
    - botInstanceStartBlock: the block number at which the bot started this current instance.
    - txQueue: a String of the Ping hashes to send, delimitered by '@'.
    - pendingTx: the hash of the pending tx.
*/


/***************************************************
 * Global constants
 */
const infuraEndpoint = `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`;
const infuraWSS = `wss://sepolia.infura.io/ws/v3/${process.env.INFURA_KEY}`;
const web3 = new Web3(infuraWSS);
const contractAddress = '0xa7f42ff7433cb268dd7d59be62b00c30ded28d3d';
const contractABI = [{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"address","name":"pinger","type":"address"}],"name":"NewPinger","type":"event"},{"anonymous":false,"inputs":[],"name":"Ping","type":"event"},{"anonymous":false,"inputs":[{"indexed":false,"internalType":"bytes32","name":"txHash","type":"bytes32"}],"name":"Pong","type":"event"},{"inputs":[{"internalType":"address","name":"_pinger","type":"address"}],"name":"changePinger","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"ping","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"pinger","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"_txHash","type":"bytes32"}],"name":"pong","outputs":[],"stateMutability":"nonpayable","type":"function"}];
const accountAddress = process.env.ACC_ADDRESS;
const privateKey = '0x' + process.env.PRIVATE_KEY;
const signer = web3.eth.accounts.privateKeyToAccount(privateKey);   // Create a signing account from a private key.
const startManualStatusCheckAfterNumBlocks = 15;    // The number of blocks after which the bot will start manually checking the status of a still-pending tx.
const blockReviewInterval = 2160;        // The number of blocks to repeatedly review Ping events and Pong txs, to ensure no missed Pings.


/***************************************************
 * Initialize the bot
 */
initBot();


/***************************************************
 * @dev Initiaize the bot by:
 *      - Connecting to the smart contract (PingPong.sol)
 *      - Setting up the wallet and account
 *      - Setting up listeners for Ping events and new block headers.
 *      (Contract address: https://sepolia.etherscan.io/address/0xa7f42ff7433cb268dd7d59be62b00c30ded28d3d)
 */
async function initBot() {

    try {
        // Must initialize the storage package before using it. Can use default options.
        await storage.init();

        // See https://docs.infura.io/tutorials/ethereum/call-a-contract for instructions to call contract method.
        // Add signing account to the local in-memory wallet.
        web3.eth.accounts.wallet.add(signer);

        contract = new web3.eth.Contract(contractABI, contractAddress);

        // Listen listerner for Ping events. (web3 provider must be a web socket to listen to contract events: https://docs.web3js.org/guides/events_subscriptions/)
        try {
            // Block number to start listening from.
            let pingEventListener = contract.events.Ping({ fromBlock: "latest" })
            // Fired when we get a new log that matches the filters for the event type we subscribed.
            pingEventListener.on('data', (event) => {handlePingEvent(event); })
            // Fired if the subscribe transaction was rejected by the network with a receipt, the second parameter will be the receipt.
            pingEventListener.on('error', (err) => { genericErrHandler(err,'listening to contract events'); });
    
            // Subscribe to Infura to monitor new block generation and analyze an active tx if applicable.
            // Could also use 'web3.eth.subscribe' directly, but Infura events fire in a more timely manner.
            try {
                web3_InfuraWS = new Web3(new Web3.providers.WebsocketProvider(infuraWSS));
                let subscribe_newBlocks = await web3_InfuraWS.eth.subscribe('newHeads');
                // Subscribe to new block header events.
                subscribe_newBlocks.on('data', (blockHeader) => { processLatestBlock(Number(blockHeader.number)); });
            } catch (err) { genericErrHandler(err,'starting and running the block header listener'); }
        } catch (err) { genericErrHandler(err,'starting and running Ping event listener'); }
    } catch (err) { genericErrHandler(err,'connecting to contract'); }
}


/***************************************************
 * @dev Subscribe to Infura's new block header web socket, and handle new block events.
 *      This includes deciding whether a check of missed Ping events in prior blocks is needed.
 * @param blockNumber - the lastest block number (Number).
 */
async function processLatestBlock(blockNumber) {
    /**************************************
     * Block processing - Part A
     **************************************/
    // If the bot is just starting (this is the first block header it has seen), then perform some special functions.
    async function blockProcessingPart_A() {
        // Update the block number.
        latestBlockNumber = blockNumber;

        if (BOT_STARTING) {
            BOT_STARTING = false;       // Undo the BOT_STARTING flag.

            // If this is a new original start for the bot with this account address, then save block number as the one when the bot started.
            let ORIGINAL_BOT_RUN = false;
            try {
                firstLoadBlockNumber = await storage.getItem('firstLoadBlockNumber');
                addressBotIsRunningWith = await storage.getItem('addressBotIsRunningWith');
            // If an error is thrown, it is because the storage items have not been created. This is an original deployment.
            } catch (err) { ORIGINAL_BOT_RUN = true; }
            // If the bot has never run previously with this account.
            if (firstLoadBlockNumber == '' || accountAddress != addressBotIsRunningWith) { ORIGINAL_BOT_RUN = true; }

            // If this is an original run for this account.
            if (ORIGINAL_BOT_RUN) {
                firstLoadBlockNumber = blockNumber;
                // Setup storage.
                await storage.setItem('addressBotIsRunningWith', accountAddress);
                await storage.setItem('firstLoadBlockNumber', firstLoadBlockNumber);
                await storage.setItem('lastCheckedBlockNumber', '');
                await storage.setItem('botInstanceStartBlock', blockNumber);
                await storage.setItem('txQueue', '');
                await storage.setItem('pendingTx', '');
                await storage.setItem('txHistory', '');
            // Else this is a new instance of a previously started session.
            } else {
                // Get the last checked block number from a previous session.
                let fromBlock = await storage.getItem('lastCheckedBlockNumber');
                // Set storage variables.
                await storage.setItem('botInstanceStartBlock', blockNumber);
                await storage.setItem('txHistory', '');

                // Check for a pending tx from a previous bot session, and handle the outcome.
                await manuallyCheckPendingTx(true)
                .then(async () => {
                    // Check in between sessions for any missed Ping events.
                    fromBlock = Number(fromBlock) + 1;      // Search is inclusive of this block number itself.
                    let toBlock = blockNumber - 1;          // Search is inclusive of this block number itself.
                    if (fromBlock < toBlock) { await checkForMissedPings(fromBlock, toBlock); }
                })
            }

        // If the bot has already processed at least one new block header.
        } else {
            // Check that no blocks have been missed, for example due to internet going down temporarily.
            async function checkForMissedBlocksBetweenInstances() {
                let previouslyCheckedBlockNumber = Number(await storage.getItem('lastCheckedBlockNumber'));
                let blockDistance = blockNumber - previouslyCheckedBlockNumber;
                if (blockDistance > 1) {
                    let fromBlock = previouslyCheckedBlockNumber + 1;   // Search is inclusive of this block number itself.
                    let toBlock = blockNumber - 1;                      // Search is inclusive of this block number itself.
                    if (fromBlock <= toBlock) { await checkForMissedPings(fromBlock, toBlock); }
                }
            }
            await checkForMissedBlocksBetweenInstances()
            .then(async () => {
                // Every 'x' blocks, check that no ping events have been missed, in case of network issues, and process them if they have.
                let blockDistance = blockNumber - await storage.getItem('botInstanceStartBlock');
                if (blockDistance % blockReviewInterval == 0 ) {
                    let toBlock = blockNumber - 1;                      // Search is inclusive of this block number itself.
                    let fromBlock = toBlock - (blockReviewInterval * blockReviewFailureCount) + 1;  // Search is inclusive of this block number itself.
                    await checkForMissedPings(fromBlock, toBlock)
                    .then((result) => {
                        if (result) { blockReviewFailureCount = 1; } else { blockReviewFailureCount++; }
                    })
                }
            });
        }
    }

    // Wait to perform the first part (the function above).
    await blockProcessingPart_A();

    /**************************************
     * Block processing - Part B
     **************************************/
    // Store the block number as the latest block that has been checked by the bot.
    await storage.setItem('lastCheckedBlockNumber', blockNumber);   // This should be updated here and not earlier, as the old value is used earlier.
    // If there is currently a pending tx and it's arrived in the mempool.
    let hash = await storage.setItem('pendingTx');
    if (STATE_pendingTx && hash != '') {
        // Update gas prices first.
        await updateGasPrice()
        .then(async () => {
            // Only proceed if the base fee has updated successfully from 'updateGasPrice()',
            // and if 'pendingTxStartBlock' has a value (it is set to null on the block the tx is confirmed, but that may happen after having entered this code block).
            if (baseFeeGwei != undefined && pendingTxStartBlock != null) {
                // If the tx has been pending for more than 'x' blocks, start manually checking its status, as we may have missed the 'on("receipt")' event due to network faults.
                if ((latestBlockNumber - pendingTxStartBlock) > startManualStatusCheckAfterNumBlocks) {
                    let txConfirmed = await manuallyCheckPendingTx(false);
                    // Compare its gas price with the current gas price, and resubmit the tx if the current gas price exceeds 80% of the submitted price.
                    if (!txConfirmed && baseFeeGwei != undefined && pendingGasPriceGwei != '' && baseFeeGwei > pendingGasPriceGwei * 0.8) {
                        prepareAndSendTx(pendingPongData, pendingNonce);
                    }
                } else {
                    // Compare its gas price with the current gas price, and resubmit the tx if the current gas price exceeds 80% of the submitted price.
                    if (baseFeeGwei != undefined && pendingGasPriceGwei != '' && baseFeeGwei > pendingGasPriceGwei * 0.8) {
                        prepareAndSendTx(pendingPongData, pendingNonce);
                    }
                }
            }
        })
    // If the tx queue is not currently being processed, then assess whether the tx queue needs processing.
    } else if (!STATE_processingQueue) { countAndExecuteTxQueue(); }
}


/***************************************************
 * @dev Call Infura to update the gas price.
 * @returns true/false (Boolean) - gas price successfully updated?
 */
async function updateGasPrice() {
    return new Promise(async (resolve, reject) => {
        let priorityFeeGwei;
        let fastPriorityFeeGwei;
        baseFeeGwei = undefined;
        safeMaxFeeGwei = undefined;    // This is to ensure that no txs are attempted if we are not getting gas information.
        // Get the priority fee estimate.
        await axios.post(infuraEndpoint, { jsonrpc: '2.0', method: 'eth_maxPriorityFeePerGas', params: [], id: 1 })   // Results returned in WEI.
        .then(async (response) => {
            let priorityFeeWei = web3.utils.hexToNumber(response.data.result, true);
            priorityFeeGwei = parseFloat(Number(web3.utils.fromWei(priorityFeeWei, 'gwei')).toFixed(4));
            fastPriorityFeeGwei = (priorityFeeGwei + 0.5).toFixed(4);
            // Get the gas price estimate.
            await axios.post(infuraEndpoint, { jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })   // Results returned in WEI.
            .then((response) => {
                let maxFeeWei = web3.utils.hexToNumber(response.data.result, true);
                let maxFeeGwei = parseFloat(Number(web3.utils.fromWei(maxFeeWei, 'gwei')).toFixed(4));
                baseFeeGwei = (maxFeeGwei - priorityFeeGwei).toFixed(4);
                safeMaxFeeGwei = Number(2 * Number(baseFeeGwei) + Number(fastPriorityFeeGwei)).toFixed(4);
                resolve(true);
            })
            .catch((err) => { genericErrHandler(err,'fetching Sepolia gas price from Infura'); reject(false); });
        })
        .catch((err) => { genericErrHandler(err,'fetching Sepolia max priority fee from Infura'); reject(false); });
    })
}


/***************************************************
 * @dev Handle a new Ping() event.
 * @param event - the event object that came with the fired event.
 */
async function handlePingEvent(event) {
    // Add ping tx hash to queue.
    await addToQueue(event.transactionHash);
    // If the tx queue is not currently being processed, then initiate that.
    if (!STATE_processingQueue) countAndExecuteTxQueue();
}


/***************************************************
 * @dev Add a Ping event hash to the tx queue.
 * @param hash - the hash of the Ping event tx object.
 */
async function addToQueue(hash) {
    // Add ping tx hash to queue.
    let queue = await storage.getItem('txQueue');
    if (queue == '') { await storage.setItem('txQueue', hash); }
    else { await storage.setItem('txQueue', queue + '@' + hash); }
}


/***************************************************
 * @dev Check the transaction queue, count the queue length, and decide whether to initiate a new transaction process.
 */
async function countAndExecuteTxQueue() {
    STATE_processingQueue = true;
    txQueue = await storage.getItem('txQueue');
    // Start processing the remaining txs in the queue.
    if (txQueue != '') { processTxQueue(); } else { STATE_processingQueue = false; }
}


/***************************************************
 * @dev Process queued transactions.
 */
async function processTxQueue() {
    // If there is not a currently pending tx.
    if (!STATE_pendingTx) {
        // There is no pending tx, so get the next tx in the queue.
        txQueue = await storage.getItem('txQueue');
        // If the transaction queue has something in it.
        if (txQueue != '') {
            // Update gas prices.
            await updateGasPrice()
            .then(async () => {
                // If we do not have a gas price yet then call exit and call this function again in a little bit.
                if (safeMaxFeeGwei == undefined) { setTimeout(() => { processTxQueue(); }, 3000); return; }
                // Get the next Ping tx hash in the queue.
                let queueArray = txQueue.split('@');
                let pingHashToSend = queueArray[0];
                // Setup a new Pong transaction with this hash as the data.
                let nonce = await web3.eth.getTransactionCount(accountAddress);
                // Issue a transaction that calls the 'pong' method.
                prepareAndSendTx(pingHashToSend, nonce);
            })
            .catch((err) => { setTimeout(() => { processTxQueue(); }, 3000); });
        }
    }
}


/***************************************************
 * @dev Build and send a call to the Pong() method.
 * @param pongData - the hash of the Ping event transaction which this Pong() call is in response to.
 * @param nonce - the nonce to use for the transaction (Number).
 */
async function prepareAndSendTx(pongData, nonce) {
    try {
        const pongMethodABI = contract.methods.pong(pongData).encodeABI();
        const tx = {
            from: accountAddress,
            to: contractAddress,
            data: pongMethodABI,
            value: '0',
            gasPrice: web3.utils.toWei(safeMaxFeeGwei, 'gwei'),
            nonce: nonce,
        };
        const gasEstimate = await web3.eth.estimateGas(tx);
        tx.gas = gasEstimate;
        const signedTx = await web3.eth.accounts.signTransaction(tx, privateKey);
        // Send the transaction by calling the pong() function.
        web3.eth.sendSignedTransaction(signedTx.rawTransaction)
        .on("sending", (sending) => {
            // Update the pending tx flag.
            STATE_pendingTx = true;
            // Save key tx parameters, in case we need to resubmit at a new gas price.
            pendingGasPriceGwei = tx.gasPrice;
            pendingNonce = tx.nonce;
            pendingPongData = pongData;
        })
        // When tx submitted to mempool, output to console and setup monitoring of the tx.
        .on("transactionHash", async (txHash) => {
            await storage.setItem('pendingTx', txHash); // This should come first in case of errors executing the code below.
            pendingTxHash = txHash;
            pendingTxStartBlock = latestBlockNumber;     // Start counting how many blocks the tx is pending for. If there are too many, we will start to manually check the tx status.
        })
        // Fires upon tx confirmation.
        .on("receipt", async (receipt) => {
            // Check this first: ensure that this is not an old event (due to network error) relating to a prior tx that has already been confirmed by the bot via another route. Extremely unlikely, but must be managed.
            if (receipt.transactionHash == pendingTxHash) {
                // Then check this: ensure that another function has not already called the bot to handle this confirmed tx.
                if (!STATE_handlingConfirmedTx) {
                    STATE_handlingConfirmedTx = true;
                    handleConfirmedTx(receipt.blockNumber);
                }
            }
        })
        .on("error", (err) => {
            genericErrHandler(err,'from network with transaction');
            // Reset the processing of the tx queue to try again (the queue will fire for reprocessing on the next block).
            STATE_pendingTx = false;
            STATE_processingQueue = false;
            pendingTxHash = null;
            pendingGasPriceGwei = null;
            pendingNonce = null;
            pendingPongData = null;
            pendingTxStartBlock = null;
        })
        .catch((err) => {
            genericErrHandler(err,'executing "sendSignedTransaction" command or fulfilling one of its event listeners.');
            // If a tx is not yet pending, then try again from 'processTxQueue()'.
            if (!STATE_pendingTx) { setTimeout(() => { processTxQueue(); }, 3000); }
            // There should be no error different to this, once the code is tested, for the code after a tx is pending is just simple variable assignments and console outputs.
            // If there is an error and a tx is pending, the error must be from the network, and it will be caught by '.on("error")'.
        });
    } catch (err) {
        setTimeout(() => { prepareAndSendTx(pongData, nonce); }, 3000);     // Try again, it's unlikely to be a permanent error.
    }
}


/***************************************************
 * @dev Respond to the confirmation of a transaction.
 * @param blockNumber - the block number in which the transaction was confirmed (Number/String).
 */
async function handleConfirmedTx(blockNumber) {
    // Update the tx queue by finding and removing the confirmed tx's ping hash.
    txQueue = await storage.getItem('txQueue');
    if (txQueue.indexOf(pendingPongData + '@') >= 0) {
        txQueue = txQueue.replace(pendingPongData + '@', '');
    } else {
        txQueue = txQueue.replace(pendingPongData, '');
    }
    await storage.setItem('txQueue', txQueue);
    // Update the tx history.
    let txHistory = await storage.getItem('txHistory');
    if (txHistory == '') {
        txHistory = pendingPongData;
    } else {
        txHistory = txHistory + '@' + pendingPongData;
    }
    await storage.setItem('txHistory', txHistory);
    // Update other variables.
    await storage.setItem('pendingTx', '');
    STATE_pendingTx = false;
    pendingTxHash = null;
    pendingGasPriceGwei = null;
    pendingNonce = null;
    pendingPongData = null;
    pendingTxStartBlock = null;
    // In case we're in the middle of manually checking this transaction, only reset the 'STATE_handlingConfirmedTx' flag when the manual check has finished.
    // This is to ensure that the current function 'handleConfirmedTx()' is not accidentally called a second time by the manual tx status checking function, potentially nullifying a newer tx that is not yet confirmed. It is unlikely, but must be managed.
    while (STATE_handlingConfirmedTx) { STATE_handlingConfirmedTx = STATE_manualCheckInProgress; }
    // Check the tx queue again for any more txs to process.
    // Wait a moment before executing, however, to give time so any Ping events waiting to be added to queue can do so.
    setTimeout(() => { countAndExecuteTxQueue(true); }, 3000);
}


/***************************************************
 * @dev Called upon bot start, when necessary, to check for missed blocks and look therein for ping() events.
 * @param fromBlock - the block number when to start looking, inclusive of itself (Number/String/BN/BigNumber).
 * @param toBlock - the block number when to stop looking, inclusive of itself (Number/String/BN/BigNumber).
 */
async function checkForMissedPings(fromBlock, toBlock) {
    return new Promise(async (resolve) => {
        try {
            // Get contract events.
            let missedPings = await contract.getPastEvents('Ping', {
                fromBlock: fromBlock,
                toBlock: toBlock
            });
            // If there are no missed Ping events found...
            if (missedPings.length == 0) { resolve(true); }
            // There are missed Ping events...
            else {
                // Add unique and new Ping events to the tx queue.
                async function processMissedPings() {
                    // Check that the hash is not already in the queue, nor in the tx history.
                    txQueue = await storage.getItem('txQueue');
                    let txHistory = await storage.getItem('txHistory');
                    for (let i = 0; i < missedPings.length; i++) {
                        let hash = missedPings[i].transactionHash;
                        // If the hash is not in the tx queue or tx history, then add it to the queue. Else ignore it.
                        if (txHistory == '' || !txHistory.includes(hash)) {
                            if (txQueue == '' || !txQueue.includes(hash)) {
                                await addToQueue(hash);
                            }
                        }
                    }
                    return;
                }
                await processMissedPings();
                // If the tx queue is not currently being processed, then initiate that.
                if (!STATE_processingQueue) countAndExecuteTxQueue(false);
                resolve(true);
            }
        } catch (err) {
            resolve(false);
        }
    })
}


/***************************************************
 * @dev Manually check whether a transaction that was left pending has been confirmed, and respond appropriately.
 * @param FirstRun - TRUE if the bot is just starting a new instance, processing its first block. FALSE otherwise. (Boolean)
 * @returns true/false (Boolean) - has the tx been confirmed?
 */
async function manuallyCheckPendingTx(isFirstRun) {
    STATE_manualCheckInProgress = true;     // Signal that we're starting a manual check of the tx status.
    // Get a prior pending tx hash, if it exists.
    let priorPendingTxHash = await storage.getItem('pendingTx');
    if (priorPendingTxHash != '') {
        // Check whether the tx is now confirmed.
        await web3.eth.getTransaction(priorPendingTxHash)
        .then(async (txData) => {
            // If the tx has been mined.
            if (txData.blockNumber != null) {
                // Check that another function has not currently called the bot to handle this confirmed tx.
                // This check is only necessary when we are managing a long-time pending tx that was initiated by this bot instance, such that both auto and manual status confirmations are operating.
                // This chech is not relevant when checking a tx left pending from a previous bot instance.
                if (!STATE_handlingConfirmedTx) {
                    STATE_handlingConfirmedTx = true;           // Flag that we are now initiating handling of the tx confirmation.
                    STATE_manualCheckInProgress = false;        // Manual check has finished. We are now confirming the tx.
                    await handleConfirmedTx(txData.blockNumber);
                    return true;
                }
            // Else it is still pending.
            } else {
                // Only perform the following if we are doing this function once upon bot start.
                // If we are here because there was a failure monitoring a tx that we just submitted, then do nothing, simply wait for the next block and check again.
                if (isFirstRun) {
                    STATE_pendingTx = true;
                    STATE_processingQueue = true;
                    // Save key tx parameters, in case we need to resubmit at a new gas price.
                    pendingGasPriceGwei = Number(web3.utils.fromWei(txData.gasPrice, "gwei"));
                    pendingNonce = txData.nonce;
                    txQueue = await storage.getItem('txQueue');
                    let queueArray = txQueue.split('@');
                    pendingPongData = queueArray[0];
                }
                STATE_manualCheckInProgress = false;
                return false;
            }
        })
        .catch(async (err) => {
            if (err.code == 430) {
                // The code should never get here if it's not the first run.
                console.log('A transaction of that hash no longer exists. It must have been cancelled or replaced with a new transaction of a higher gas fee.');
                // It's unknown how we would get here, but just in case...
                if (!isFirstRun) { console.log(('Please restart the bot.').errorColor); }
            } else {
                if (isFirstRun) {
                    genericErrHandler(err,'processing a formerly pending transaction. Process aborted');
                    await storage.setItem('pendingTx', '');
                }
            }
            // If we're on the first run, then  reset the 'pendingTx' storage item.
            if (isFirstRun) await storage.setItem('pendingTx', '');
            // If we're not on the first run, then the error is a network error, so ignore it and try again on the next block.
            STATE_manualCheckInProgress = false;
            return false;
        });
    // No previously pending tx found.
    } else {
        // We can only be here if we're on the first run, so conclude there was no pending tx from a prior bot session.
        STATE_manualCheckInProgress = false;
        return false;
    }
}


/***************************************************
 * @dev A generic error handler to write error information
 *      to the console, and if requested, into a notification
 *      visible to the user.
 * @param err - the error object generated when the error was thrown.
 * @param description - a helpful description of the error (String).
 */
function genericErrHandler(err, description) {
    console.error(`Error ${description}: ${err.message}.\nCode: ${err.code}. Data: ${err.data}`);
}