/**
 *  @title: Ping Pong bot.
 *  @author: Tim Mapperson
 *  @repo: https://github.com/Agathos316/
 */


/***************************************************
 * @dev Bot settings to be configured by the user.
 */
const DEPLOYMENT_TYPE = 'Updateable';   // Either 'Updateable' or 'Not-Updateable', depending on whether the console can handle same-line updates.
const mockupFromBlock = '';     // Set this to do a mock start a the designed block number.


/***************************************************
 * @dev Import/Require necessary packages.
 */
// These lines make "require" available even though this file is of "type": "module".
import { createRequire } from "module";
const require = createRequire(import.meta.url);
// Bring in the necessary packages.
const { Web3 } = require('web3');
require('dotenv').config();
const storage = require('node-persist');
const axios = require('axios');
const colors = require('colors');
import logUpdate from 'log-update';


/***************************************************
 * Global variables
 */
// Variables.
let web3_InfuraWS;
let contract;
let addressBotIsRunningWith;
let txQueue;
let pendingGasPriceGwei;
let pendingNonce;
let pendingPongData;
let safeMaxFeeGwei;
let firstLoadBlockNumber;
let workingIndex = 0;
let workingAnimationID;
// Flags/State variables.
let BOT_STARTING = true;
let STATE_pendingTx = false;
let STATE_processingQueue = false;
/* Persistent storage items to be managed:
    - addressBotIsRunningWith: the account address the bot is or was running with last.
    - firstLoadBlockNumber: the block number when the bot first started using the current account address.
    - lastCheckedBlockNumber: the block number most recently listened to for Ping events.
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
const workingFrames = ['>    ', '_>   ', '__>  ', '___> ', '____>', '_____>', '______>', '______<', '_____< ',  '____< ', '___< ', '__<  ', '_<   ', '<    '];
colors.setTheme({
    actionColor: 'green',  
    titleColor: 'yellow',
    eventColor: 'yellow',
    infoColor: 'cyan',
    errorColor: 'red',
    headerColor: 'grey'
});


/***************************************************
 * Initialize the bot
 */
// Must initialize the storage package before using it. Can use default options.
await storage.init();
// Prepare the bot if this is a mock-run (for testing purposes).
if (mockupFromBlock != '') {
    console.log(('!!Mockup run in progress!!').titleColor);
    await storage.setItem('addressBotIsRunningWith', accountAddress);
    await storage.setItem('firstLoadBlockNumber', mockupFromBlock - 10);
    await storage.setItem('lastCheckedBlockNumber', mockupFromBlock);
    await storage.setItem('txQueue', '');
    await storage.setItem('pendingTx', '');
}
// Call the main initialization function.
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

        // See https://docs.infura.io/tutorials/ethereum/call-a-contract for instructions to call contract method.
        // Add signing account to the local in-memory wallet.
        web3.eth.accounts.wallet.add(signer);

        console.log(('\nConnected account: ' + accountAddress).infoColor);
        contract = new web3.eth.Contract(contractABI, contractAddress);
        console.log(('Connected to contract: ' + contractAddress + '\n').infoColor);

        // Listen listerner for Ping events. (web3 provider must be a web socket to listen to contract events: https://docs.web3js.org/guides/events_subscriptions/)
        try {
            let pingEventListener = contract.events.Ping({
                fromBlock: "latest" // Block number to start listening from.
            }, (error, event) => {
                // Fired when we get a new log that matches the filters for the event type we subscribed to.
                if (!error) { console.log(('Listening started: ' + event).actionColor); }
                else { console.log(('Listening NOT started: ' + error).errorColor); }
            })
            pingEventListener.on("connected", (subscriptionId) => {
                // Fired after subscribing to an event.
                console.log(('Listening for new Ping events...').actionColor);
            })
            pingEventListener.on('data', (event) => {
                // Fired when we get a new log that matches the filters for the event type we subscribed.
                handlePingEvent(event);
            })
            pingEventListener.on('error', (err, receipt) => {
                // Fired if the subscribe transaction was rejected by the network with a receipt, the second parameter will be the receipt.
                console.log(('Error receipt: ' + receipt).errorColor);
                genericErrHandler(err,'listening to contract events');
            });
    
            // Subscribe to Infura to monitor new block generation and analyze an active tx if applicable.
            // Could also use 'web3.eth.subscribe' directly, but Infura events fire in a more timely manner.
            try {
                web3_InfuraWS = new Web3(new Web3.providers.WebsocketProvider(infuraWSS));
                let subscribe_newBlocks = await web3_InfuraWS.eth.subscribe('newHeads', function(err, result) {
                    if (err) console.log(err);
                });
                // Subscribe to new block header events.
                subscribe_newBlocks.on('data', (blockHeader) => {
                    processLatestBlock(Number(blockHeader.number));
                });
                console.log(('Listening for new block headers...').actionColor);
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
    // Update gas price estimates first, in case a tx is needed soon.
    let priorityFeeGwei;
    let fastPriorityFeeGwei;
    let baseFeeGwei = undefined;
    safeMaxFeeGwei = undefined;    // This is to ensure that no txs are attempted if we are not getting gas information.
    // Get the priority fee estimate.
    axios.post(infuraEndpoint, { jsonrpc: '2.0', method: 'eth_maxPriorityFeePerGas', params: [], id: 1 })   // Results returned in WEI.
    .then((response) => {
        let priorityFeeWei = web3.utils.hexToNumber(response.data.result, true);
        priorityFeeGwei = parseFloat(Number(web3.utils.fromWei(priorityFeeWei, 'gwei')).toFixed(4));
        fastPriorityFeeGwei = (priorityFeeGwei + 0.5).toFixed(4);
        // Get the gas price estimate.
        axios.post(infuraEndpoint, { jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })   // Results returned in WEI.
        .then((response) => {
            let maxFeeWei = web3.utils.hexToNumber(response.data.result, true);
            let maxFeeGwei = parseFloat(Number(web3.utils.fromWei(maxFeeWei, 'gwei')).toFixed(4));
            baseFeeGwei = (maxFeeGwei - priorityFeeGwei).toFixed(4);
            safeMaxFeeGwei = Number(2 * Number(baseFeeGwei) + Number(fastPriorityFeeGwei)).toFixed(4);
            finishLatestBlockProcessing();      // This function is just a few lines below here.
        })
        .catch((err) => { genericErrHandler(err,'fetching Sepolia gas price from Infura'); });
    })
    .catch((err) => { genericErrHandler(err,'fetching Sepolia max priority fee from Infura'); });
    
    // Put this in a function, and call it in the code above to ensure gas estimates are complete before executing this code.
    async function finishLatestBlockProcessing() {

        // If the bot is just starting (this is the first block header it has seen), then perform some special functions.
        if (BOT_STARTING) {
            BOT_STARTING = false;       // Undo the BOT_STARTING flag.
            clearInterval(workingAnimationID);
            logUpdate(('\n' + new Date(Date.now()).toUTCString()).titleColor);
            logUpdate.done();

            // If this is a new original start for the bot with this account address, then save block number as the one when the bot started.
            let ORIGINAL_BOT_RUN = false;
            try {
                firstLoadBlockNumber = await storage.getItem('firstLoadBlockNumber');
                addressBotIsRunningWith = await storage.getItem('addressBotIsRunningWith');
            } catch (err) {
                // If an error is thrown, it is because the storage items have not been created. This is an original deployment.
                ORIGINAL_BOT_RUN = true;
            }
            // If the bot has never run previously with this account.
            if (firstLoadBlockNumber == '' || accountAddress != addressBotIsRunningWith) {
                ORIGINAL_BOT_RUN = true;
            }

            // If this is an original run for this account.
            if (ORIGINAL_BOT_RUN) {
                firstLoadBlockNumber = blockNumber;
                ///* -> -> THIS LINE IS USED FOR TESTING PURPOSES ONLY -> -> */ if (MOCKUP) firstLoadBlockNumber = mockupFirstLoadBlockNumber;
                console.log('Bot is running for the first time on this address, starting at block number ' + firstLoadBlockNumber + '.');
                // Setup storage.
                await storage.setItem('addressBotIsRunningWith', accountAddress);
                await storage.setItem('firstLoadBlockNumber', firstLoadBlockNumber);
                await storage.setItem('lastCheckedBlockNumber', '');
                await storage.setItem('txQueue', '');
                await storage.setItem('pendingTx', '');
            // Else this is a new instance of a previously started session.
            } else {
                console.log('Bot has run with this account before, originally starting at block number ' + firstLoadBlockNumber + '.');
                // Get the last checked block number from a previous session.
                let fromBlock = await storage.getItem('lastCheckedBlockNumber');
                ///* -> -> THIS LINE IS USED FOR TESTING PURPOSES ONLY -> -> */ if (mockupFromBlock != '') fromBlock = mockupFromBlock;
                if (fromBlock == '') {
                    console.log(('Storage item "lastCheckedBlockNumber" failed to be set in the previous bot session. Ignoring and waiting for next block.').errorColor);
                }
                console.log('Bot ended previous session at block number ' + fromBlock + '.');
                console.log('Current bot session starting at block number ' + blockNumber + '.');

                // Check for a pending tx from a previous bot session.
                await checkPreviousPendingTx()
                .then(async () => {
                    // Check in between sessions for any missed Ping events.
                    fromBlock = Number(fromBlock) + 1;      // Search is inclusive of this block number itself.
                    let toBlock = blockNumber - 1;          // Search is inclusive of this block number itself.
                    if (fromBlock < toBlock) {
                        console.log(('\nMissed blocks ' + fromBlock + ' to ' + toBlock + ' in between bot sessions.').infoColor);
                        console.log('Checking for missed Ping events in that period...');
                        await checkForMissedBlocks(fromBlock, toBlock);
                    }
                })
            }

        // If the bot has already processed at least one new block header.
        } else {
            // Check that no blocks have been missed, for example due to internet going down temporarily.
            let previouslyCheckedBlockNumber = Number(await storage.getItem('lastCheckedBlockNumber'));
            let distanceBetweenBlockNumbers = blockNumber - previouslyCheckedBlockNumber;
            if (distanceBetweenBlockNumbers > 1) {
                let fromBlock = previouslyCheckedBlockNumber + 1;   // Search is inclusive of this block number itself.
                let toBlock = blockNumber - 1;                      // Search is inclusive of this block number itself.
                if (fromBlock <= toBlock) {
                    clearInterval(workingAnimationID);
                    logUpdate(('\n' + new Date(Date.now()).toUTCString()).titleColor);
                    logUpdate.done();
                    console.log(('Missed blocks ' + fromBlock + ' to ' + toBlock + '.').infoColor);
                    console.log('Checking for missed Ping events in that period...');
                    checkForMissedBlocks(fromBlock, toBlock);
                }
            }
        }

        // Store the block number as the latest block that has been checked by the bot.
        await storage.setItem('lastCheckedBlockNumber', blockNumber);

        // If there is currently a pending tx, then compare its gas price with the current gas price, and resubmit the tx if the current gas price exceeds 80% of the submitted price.
        if (STATE_pendingTx) {
            if (baseFeeGwei != undefined && pendingGasPriceGwei != '' && baseFeeGwei > pendingGasPriceGwei * 0.8) {
                prepareAndSendTx(pendingPongData, pendingNonce);
            }
        // If the tx queue is not currently being processed, then initiate a check of the transaction queue for any new txs that need to be processed.
        } else if (!STATE_processingQueue) {
            // If we are not processing the tx queue, then only output here if we're using an updateable console, or the block number is divisible by 100 (i.e. output every hundredth block if not a same-line updateable console).
            if (DEPLOYMENT_TYPE == 'Updateable' || blockNumber % 100 == 0) {
                clearInterval(workingAnimationID);
                setWorkingString('\nLatest block number ' + blockNumber + ', Safe max gas fee: ' + safeMaxFeeGwei + ' GWEI ', '\n');
            }
            // Consider whether the tx queue needs processing.
            countAndExecuteTxQueue(false);
        }
    }
}


/***************************************************
 * @dev Handle a new Ping() event.
 * @param event - the event object that came with the fired event.
 */
async function handlePingEvent(event) {
    /*// Do not process this while a transaction is underway. Wait until it is finished.
    // This is just so the console updates in the correct order. The bot will work fine even if the ping event is handled immediately.
    if (STATE_pendingTx) {
        setTimeout(() => { handlePingEvent(event); }, 1000);
    } else {*/
        clearInterval(workingAnimationID);
        logUpdate(('\n' + new Date(Date.now()).toUTCString()).eventColor);
        logUpdate.done();
        console.log(('Ping heard at block number ' + event.blockNumber + ', tx hash ' + event.transactionHash).eventColor);
        await addToQueue(event.transactionHash);    // Add ping tx hash to queue.
        console.log(('A Pong response has been added to transaction queue.').eventColor);
        // If the tx queue is not currently being processed, then initiate that.
        if (!STATE_processingQueue) countAndExecuteTxQueue(true);
    //}
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
 * @param showOutput - whether to send detailed output to console or not (Boolean).
 */
async function countAndExecuteTxQueue(showOutput) {
    STATE_processingQueue = true;
    txQueue = await storage.getItem('txQueue');
    if (txQueue != '') {
        let queueArray = txQueue.split('@');
        let totalNumTxs = queueArray.length;
        if (totalNumTxs == 1) {
            console.log(('\nTotal of ' + totalNumTxs + ' Pong in transaction queue.').infoColor);
            if (showOutput) {
                console.log('Ping tx hashes:');
                console.log('1: ' + txQueue);
            }
            console.log(('\nSending Pong response while continuing to listen for new blocks and Ping events...').actionColor);
        } else if (totalNumTxs > 1 && showOutput) {
            console.log(('\nTotal of ' + totalNumTxs + ' Pongs in transaction queue.').infoColor);
            if (showOutput) {
                console.log('Ping tx hashes:');
                for (let i = 0; i < totalNumTxs; i++) {
                    console.log((i + 1) + ': ' + queueArray[i]);
                }
            }
            console.log(('\nSending Pong responses while continuing to listen for new blocks and Ping events...').actionColor);
        }
        // Start processing the remaining txs in the queue.
        processTxQueue();
    } else {
        if (showOutput) console.log(('\nNo more Pongs in transaction queue. Listen for Pings.').infoColor);
        STATE_processingQueue = false;
    }
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
            // If we do not have a gas price yet then call back this function in a little bit.
            if (safeMaxFeeGwei == undefined) {
                setTimeout(() => { processTxQueue(); }, 2000);
                return;
            }
            // Get the next Ping tx hash in the queue.
            let queueArray = txQueue.split('@');
            let pingHashToSend = queueArray[0];
            // Setup a new Pong transaction with this hash as the data.
            let nonce = await web3.eth.getTransactionCount(accountAddress);
            // Issue a transaction that calls the 'pong' method.
            prepareAndSendTx(pingHashToSend, nonce);
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
        // Output to console.
        clearInterval(workingAnimationID);
        // Vary the output depending on whether we're resubmitting a pending tx or submitting an entirely new tx.
        if (STATE_pendingTx) {
            logUpdate('Network gas price increased too much. Resubmitting transaction at a higher gas fee.');
            logUpdate.done();
        } else {
            logUpdate(('\n' + new Date(Date.now()).toUTCString()).titleColor);
            logUpdate.done();
            console.log(('Sending new Pong response transaction').actionColor + ' (Ping tx hash: ' + condenseHashString(pongData) + ')');
        }
        console.log('Tx gas price: ' + web3.utils.fromWei(tx.gasPrice, 'gwei') + ' GWEI, nonce: ' + tx.nonce);
        // Send the transaction by calling the pong() function.
        web3.eth.sendSignedTransaction(signedTx.rawTransaction)
        .on("sending", (sending) => {
            console.log('Submitting transaction to mempool...');
            // Update the pending tx flag.
            STATE_pendingTx = true;
            // Save key tx parameters, in case we need to resubmit at a new gas price.
            pendingGasPriceGwei = tx.gasPrice;
            pendingNonce = tx.nonce;
            pendingPongData = pongData;
        })
        // When tx submitted to mempool, output to console and setup monitoring of the tx.
        .on("transactionHash", async (txHash) => {
            await storage.setItem('pendingTx', txHash);
            web3.eth.getTransaction(txHash)
            .then((txData) => {
                clearInterval(workingAnimationID);
                logUpdate('Transaction arrived in mempool\n(tx hash: ' + txHash + ')');
                logUpdate.done();
                setWorkingString('Monitoring transaction progress', '\n');
            });
        })
        // Fires upon tx confirmation.
        .on("receipt", async (receipt) => {
            handleConfirmedTx(receipt.blockNumber);
        })
        .on("error", (err) => {
            console.log(('There was an error sending the Pong transaction.').errorColor);
            genericErrHandler(err,'sending transaction');
            // Reset the processing of the tx queue (the queue will fire for reprocessing on the next block).
            STATE_pendingTx = false;
            STATE_processingQueue = false;
            pendingGasPriceGwei = null;
            pendingNonce = null;
            pendingPongData = null;
        })
        .catch((err) => { genericErrHandler(err,'executing "sendSignedTransaction" command'); });
    } catch (err) {
        genericErrHandler(err,'preparing the next transaction. Trying again in 3 seconds...');
        setTimeout(() => { prepareAndSendTx(pongData, nonce); }, 3000);     // Try again, it's unlikely to be a permanent error.
    }
}


/***************************************************
 * @dev Respond to the confirmation of a transaction.
 * @param blockNumber - the block number in which the transaction was confirmed (Number/String).
 */
async function handleConfirmedTx(blockNumber) {
    // Output to console.
    clearInterval(workingAnimationID);
    logUpdate(('Transaction confirmed at block number ' + blockNumber + '.').infoColor);
    logUpdate.done();
    // Update the tx queue.
    txQueue = await storage.getItem('txQueue');
    // If there are multiple txs in the queue, then remove just the first one.
    if (txQueue.indexOf('@') >= 0) {
        let queueArray = txQueue.split('@');
        queueArray.shift();     // Removes first element from array.
        txQueue = queueArray.join('@');
    // If there is only one tx in the queue, then set the queue to be an empty String.
    } else {
        txQueue = '';
    }
    await storage.setItem('txQueue', txQueue);
    // Update other variables.
    await storage.setItem('pendingTx', '');
    STATE_pendingTx = false;
    pendingGasPriceGwei = null;
    pendingNonce = null;
    pendingPongData = null;
    // Check the tx queue again for any more txs to process.
    // Wait a moment before executing, however, to give time so any Ping events waiting to be added to queue can do so.
    setTimeout(() => { countAndExecuteTxQueue(true); }, 2000);
}


/***************************************************
 * @dev Called upon bot start, when necessary, to check for missed blocks and look therein for ping() events.
 * @param fromBlock - the block number when to start looking, inclusive of itself (Number/String/BN/BigNumber).
 * @param toBlock - the block number when to stop looking, inclusive of itself (Number/String/BN/BigNumber).
 */
async function checkForMissedBlocks(fromBlock, toBlock) {
    //console.log('Checking for missed pings in blocks ' + fromBlock + ' to ' + toBlock + '...');

    // Get contract events.
    let missedPings = await contract.getPastEvents('Ping', {
        fromBlock: fromBlock,
        toBlock: toBlock
    });
    // If there are no missed Ping events found...
    if (missedPings.length == 0) {
        console.log('No missing Ping events in that period.');
    // There are missed Ping events...
    } else {
        // Add unique and new Ping events to the tx queue.
        async function processMissedPings() {
            // Check that the hash is not already in the queue.
            txQueue = await storage.getItem('txQueue');
            for (let i = 0; i < missedPings.length; i++) {
                let hash = missedPings[i].transactionHash;
                // If the hash is not in the queue, then add it to the queue. Else ignore it.
                if (txQueue == '' || !txQueue.includes(hash)) {
                    await addToQueue(hash);
                    console.log('Ping found at block number ' + missedPings[i].blockNumber + '. Tx hash ' + condenseHashString(hash) + ' added to queue.');
                }
            }
            return;
        }
        await processMissedPings();
        // If the tx queue is not currently being processed, then initiate that.
        if (!STATE_processingQueue) countAndExecuteTxQueue(false);
    }
}


/***************************************************
 * @dev Check whether a previous instance of the bot left a transaction pending.
 *      Determine whether it is currently pending or confirmed, and respond appropriately.
 */
async function checkPreviousPendingTx() {
    // Check if there was a pending tx when the previous instance of the bot was stopped.
    let priorPendingTxHash = await storage.getItem('pendingTx');
    if (priorPendingTxHash != '') {
        console.log(('\nA transaction was left pending at the end of a previous bot session.').infoColor);
        console.log('Checking status of potentially pending transaction of hash: ' + priorPendingTxHash);
        // Check whether the tx is now confirmed.
        web3.eth.getTransaction(priorPendingTxHash)
        .then(async (txData) => {
            // If the tx has been mined.
            if (txData.blockNumber != null) {
                await handleConfirmedTx(txData.blockNumber);
            // Else it is still pending.
            } else {
                console.log('Transaction is still pending.');
                STATE_pendingTx = true;
                STATE_processingQueue = true;
                // Save key tx parameters, in case we need to resubmit at a new gas price.
                pendingGasPriceGwei = Number(web3.utils.fromWei(txData.gasPrice, "gwei"));
                pendingNonce = txData.nonce;
                txQueue = await storage.getItem('txQueue');
                let queueArray = txQueue.split('@');
                pendingPongData = queueArray[0];
                console.log(('Transaction is still pending. Bot is onto it...').actionColor);
            }
        })
        .catch(async (err) => {
            if (err.code == 430) {
                console.log('A transaction of that hash no longer exists. It must have been cancelled or replaced with a new transaction of a higher gas fee.');
            } else {
                genericErrHandler(err,'processing a formerly pending transaction. Process aborted');
                console.log(('There was an error trying to find information about this transaction. It will be ignored by the bot.').errorColor);
            }
            await storage.setItem('pendingTx', '');
        });
    // No previously pending tx found.
    } else {
        console.log(('\nNo pending transaction found from a previous bot session.').infoColor);
    }
}


/***************************************************
 * @dev Setup an animated console output line.
 * @param mainStr - the main string of the output line, which will go before the animated portion (String).
 * @param suffixStr - anything to go after the animated portion (such as a new blank line) (String).
 */
function setWorkingString(mainStr, suffixStr) {
    // Use this when working with a deployment that DOES accommodate line updates in the output console/log.
    if (DEPLOYMENT_TYPE == 'Updateable') {
        workingAnimationID = setInterval(() => {
            logUpdate(mainStr + workingFrames[workingIndex = ++workingIndex % workingFrames.length] + suffixStr);
        }, 150);
    // Use this when working with a deployment that does NOT accommodate line updates in the output console/log.
    } else if (DEPLOYMENT_TYPE == 'Not-Updateable') {
        console.log(mainStr + suffixStr);
    }
}


/***************************************************
 * @dev Condense a hash String, visually, by replacing many inner characters with '...'.
 * @param hash - the hash to be condensed (String).
 * @returns The condensed hash String.
 */
function condenseHashString(hash) {
    return hash.substring(0, 7) + '...' + hash.substring(hash.length - 6, hash.length - 1)
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
