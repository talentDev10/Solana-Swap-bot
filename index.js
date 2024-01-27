const fetch = require('node-fetch')
const { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createTransferInstruction, createBurnInstruction } = require('@solana/spl-token')
const { PublicKey, Keypair, Connection, SystemProgram, VersionedTransaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction, Transaction } = require('@solana/web3.js')
const bs58 = require('bs58')
const fs = require('fs')
const {Telegraf} = require('telegraf')

const crypto = require('crypto');
const dotenv = require('dotenv')
const HashList = require('./hash_list.json')
require("util").inspect.defaultOptions.depth = null
require('dotenv').config();
const adminUsernames = process.env.ADMIN_USERNAMES.split(',');


dotenv.config()

/* Global Infos */
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN)
const RPC_NODE = process.env.RPC_NODE_URL
const DAY = 24*60*60*1000
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const CultToken = new PublicKey('Cu1tCSoauo4Vtqsr9cD86RS4XJqS88LauU69AFV6KMH7')
const CultDecimals = 9


const UserDataTemplate = {
    secretKey: null,
    target: null,
    // percent: 0,
    usdcAmount: 0,
    solAmount: 0,
    isAble: false,
    isStop: true,
    GlobalAccessibilityEndTime: 0,
    rpcNode: "",
    // lastTime: 0,
    // copyCount: 0,
}

/* Admin Data */
let hashList = HashList

let adminData = {
    allowList: [
        "441TbCSc3qfiYrxcbU292GUVBS2ckZc8e6U7avZHANff",
        "h1d4hZNJJHMMk64oTd3QivBig51xNJKwRK994ok4wBw",
        "Ey4sTBk1TaGdmQoTcrW9x4mvHawzzsDnE7aDEds9BZVT",
        "fiatNNtLx98QqBf1BD9hA4nLR5v1UQVDQ1BdnDZHmgk"
    ],
    minCultAmountForAllow: 5_000_000,
    treasuryWallet: new PublicKey(process.env.TREASURY_WALLET),
    fee: {
        mint: NATIVE_MINT,
        feeAmount: 0.1,
        duration: WEEK
    },
    transactionLimit: 20,
    transactionFee: 1000,
    defaultRpcNode: RPC_NODE
}

/* User Data */
let userData = []

const sleep = (s) => {return new Promise(resolve => setTimeout(resolve, s*1000))}
const checkAccessibility = async(uD) => {
    try{
        let publicKey = uD.secretKey.publicKey
        if(adminData.allowList.find(function(item){return item==publicKey.toBase58()})!=undefined) return true
        if(uD.GlobalAccessibilityEndTime!=undefined && new Date().getTime() < uD.GlobalAccessibilityEndTime) return true
        let isNftOwned = false
        let conn = new Connection(uD.rpcNode!=undefined&&uD.rpcNode!=null&&uD.rpcNode!=""?uD.rpcNode:adminData.defaultRpcNode)
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(publicKey, {programId: TOKEN_PROGRAM_ID})
        for(let item of tokenAccounts.value){
            const tokenMint = item.account.data.parsed.info.mint
            const tokenAmount = item.account.data.parsed.info.tokenAmount
            if(tokenAmount.amount=='1' && tokenAmount.decimals==0){
                if(hashList.find(function(mint){return mint==tokenMint})!=undefined){
                    isNftOwned = true;
                    break;
                }
            }
        }
        let cultAmount = 0
        for(let item of tokenAccounts.value){
            if(item.account.data.parsed.info.mint==CultToken.toBase58()){
                cultAmount += item.account.data.parsed.info.tokenAmount.uiAmount
            }
        }
        if(isNftOwned && cultAmount > adminData.minCultAmountForAllow) return true
        return false
    }catch(err){
        return false
    }
}

const buyAccessibility = async(userId) => {
    let index = userData.findIndex((item)=>{return item.id==userId})
    if(index==-1) throw new Error("Invalid User")
    let uD = userData[index]
    let conn = new Connection(uD.rpcNode!=undefined&&uD.rpcNode!=null&&uD.rpcNode!=""?uD.rpcNode:adminData.defaultRpcNode)
    let transaction = new Transaction()
    if(adminData.fee.mint.toBase58()==NATIVE_MINT.toBase58()){
        transaction.add(SystemProgram.transfer({
            fromPubkey: uD.secretKey.publicKey,
            toPubkey: adminData.treasuryWallet,
            lamports: adminData.fee.feeAmount * LAMPORTS_PER_SOL
        }))
    }else{
        let fromTokenAccount = getAssociatedTokenAddressSync(adminData.fee.mint, uD.secretKey.publicKey, true)
        let toTokenAccount = getAssociatedTokenAddressSync(adminData.fee.mint, adminData.treasuryWallet, true)
        if((await conn.getAccountInfo(toTokenAccount))==null){
            transaction.add(createAssociatedTokenAccountInstruction(uD.secretKey.publicKey, toTokenAccount, adminData.treasuryWallet, adminData.fee.mint))
        }
        let balance = (await conn.getTokenAccountBalance(fromTokenAccount)).value
        transaction.add(createTransferInstruction(fromTokenAccount, toTokenAccount, uD.secretKey.publicKey, adminData.fee.feeAmount * (10 ** balance.decimals)))
    }
    await sendAndConfirmTransaction(conn, transaction, [uD.secretKey])
    uD.GlobalAccessibilityEndTime = (new Date().getTime() > uD.GlobalAccessibilityEndTime ? new Date().getTime() : uD.GlobalAccessibilityEndTime) + adminData.fee.duration
    return uD.GlobalAccessibilityEndTime
}

const parseTransaction = async (signature, target) => {
    const data = await (await fetch(`https://api.helius.xyz/v0/transactions/?api-key=${process.env.HELIUS_API_TOKEN}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json',},
        body: JSON.stringify({transactions: [signature]}),
    })).json()
    // console.log(data)
    let transaction = data[0]

    if(transaction.type=="SWAP") return transaction
    
    let myTokenList = []
    let me = target.toBase58()
    for(let item of transaction.tokenTransfers){
        if(item.toUserAccount==me){
            let index = myTokenList.findIndex((oneToken)=>{return oneToken.mint==item.mint})
            if(index!=-1){
                myTokenList[index].amount += item.tokenAmount
            }else{
                myTokenList.push({mint: item.mint, amount: item.tokenAmount})
            }
        }else if(item.fromUserAccount==me){
            let index = myTokenList.findIndex((oneToken)=>{return oneToken.mint==item.mint})
            if(index!=-1){
                myTokenList[index].amount -= item.tokenAmount
            }else{
                myTokenList.push({mint: item.mint, amount: -item.tokenAmount})
            }
        }
    }

    let inputTokens = []
    let outputTokens = []

    for(let item of myTokenList){
        if(item.amount < 0){
            inputTokens.push({mint: item.mint, amount: -item.amount})
        }
        if(item.amount > 0){
            outputTokens.push(item)
        }
    }
    if(transaction.feePayer==me && inputTokens.length==1 && outputTokens.length==1){
        return {feePayer: me, type: "SWAP_MANUAL", description: `${me} swapped ${inputTokens[0].amount} ${inputTokens[0].mint==NATIVE_MINT.toBase58() ? "SOL" : inputTokens[0].mint} for ${outputTokens[0].amount} ${outputTokens[0].mint==NATIVE_MINT.toBase58() ? "SOL" : outputTokens[0].mint}`, inputToken: inputTokens[0], outputToken: outputTokens[0]}
    }else{
        return transaction
    }
}



function encrypt(text, key) {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, Buffer.alloc(16, 0));
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  }

  
function decrypt(text, key) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.alloc(16, 0));
    let decrypted = decipher.update(text, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;


  }
const swap = async(uD, inputMint, outputMint, amount) => {
    let publicKey = uD.secretKey.publicKey
    let conn = new Connection(uD.rpcNode!=undefined&&uD.rpcNode!=null&&uD.rpcNode!=""?uD.rpcNode:adminData.defaultRpcNode)
    if(adminData.transactionFee>0){
        try{
            let tokenAccount = getAssociatedTokenAddressSync(CultToken, publicKey, true)
            let tokenAmount = (await conn.getTokenAccountBalance(tokenAccount)).value
            if(tokenAmount.uiAmount < adminData.transactionFee) throw new Error("You don't have enough CULT for transaction fee")
        }catch(err){
            await bot.telegram.sendMessage("You don't have enough CULT for transaction fee")
            throw new Error("You don't have enough CULT for transaction fee")
        }
    }
    let swapAmount = 0
    let decimals = 9
    if(inputMint==NATIVE_MINT.toString()){
        let balance = await conn.getBalance(publicKey)
        swapAmount = uD.solAmount * LAMPORTS_PER_SOL
        if(balance <= swapAmount) throw new Error("Your balance is not enough") 
        decimals = 9
    }else if(inputMint==USDC.toString()){
        let balance = 0
        let tokenAccounts = (await conn.getParsedTokenAccountsByOwner(publicKey, {mint: new PublicKey(inputMint)})).value
        for(let item of tokenAccounts)
            balance += Number(item.account.data.parsed.info.tokenAmount.amount)
        swapAmount = uD.usdcAmount * (10**6)
        if(balance < swapAmount) throw new Error("Your balance is not enough")
        decimals = 6
    }else{
        let myTokenAccount = getAssociatedTokenAddressSync(new PublicKey(inputMint), publicKey, true)
        let targetTokenAccount = getAssociatedTokenAddressSync(new PublicKey(inputMint), uD.target, true)
        try{
            let myBalance = (await conn.getTokenAccountBalance(myTokenAccount)).value
            let targetBalance = (await conn.getTokenAccountBalance(targetTokenAccount)).value.uiAmount
            decimals = myBalance.decimals
            swapAmount = Math.floor(Number(amount) * (myBalance.uiAmount / (targetBalance+Number(amount))) * (10**decimals))
        }catch(err){
            throw new Error("Something went wrong. Error:"+err.message)
        }
    }
    // let swapAmount = Math.floor(Number(amount) * (10**decimals) / 100 * Number(uD.percent))
    // if(balance < swapAmount) throw new Error("Your balance is not enough") //swapAmount = balance
    // console.log(`${publicKey.toBase58()} trying to swap ${swapAmount/(10**decimals)} ${inputMint==NATIVE_MINT.toString() ? "SOL" : inputMint} to ${outputMint==NATIVE_MINT.toString() ? "SOL" : outputMint}`)
    let description = `Swap ${swapAmount/(10**decimals)} ${inputMint==NATIVE_MINT.toString() ? "SOL" : inputMint} to ${outputMint==NATIVE_MINT.toString() ? "SOL" : outputMint}`
    const {data} = await (await fetch(`https://quote-api.jup.ag/v4/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${swapAmount}&slippageBps=50`)).json()
    const routes = data;
    const transactions = await (await fetch('https://quote-api.jup.ag/v4/swap', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            route: routes[0],
            userPublicKey: publicKey,
            wrapUnwrapSol: true
        })
    })).json()
    const {swapTransaction} = transactions;
    const swapTransactionBuf = Buffer.from(swapTransaction,'base64')
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf)
    transaction.sign([uD.secretKey])
    const rawTransaction = transaction.serialize()
    const txid = await conn.sendRawTransaction(rawTransaction, {skipPreflight: true, maxRetries: 2})
    let res = await conn.confirmTransaction(txid)
    if(res.value.err!=null){
        throw new Error("Something went wrong. Error: "+res.value.err)
    }
    if(adminData.transactionFee>0){
        let feeTx = new Transaction()
        let tokenAccount = getAssociatedTokenAddressSync(CultToken, publicKey, true)
        feeTx.add(createBurnInstruction(tokenAccount, CultToken, publicKey, adminData.transactionFee*(10**CultDecimals)))
        await sendAndConfirmTransaction(conn, feeTx, [uD.secretKey])
    }
    // console.log("swap transaction:   ",txid)
    // console.log("---------    S u c c e s s !    ----------\n")
    return {txid: txid, description: description}
}

const checkAccessibilityDuration = async(userId) => {
    // console.log("checking start")
    try{
        while(1){
            let index = userData.findIndex((item)=>{ return item.id==userId})
            if(index == -1) throw new Error("You didn't register")
            if(userData[index].isStop){
                await sleep(100)
                continue;
            }
            let isAble = await checkAccessibility(userData[index])
            userData[index] = {...userData[index], isAble: isAble}
            await sleep(300)
        }
    }catch(err){
        // console.log(err)
    }
}

const mainService = async(userId) => {
    try{
        let lastTx = ""
        let firstRun = 0
        let copyCount = 0
        let lastTime = new Date().getTime()
        let index = userData.findIndex((item)=>{return item.id==userId})
        if(index==-1) throw new Error("Invalid User")
        await checkAccessibility(userData[index])
        while(1){
            let index = userData.findIndex((item)=>{return item.id==userId})
            if(index==-1) throw new Error("Invalid User")
            let uD = userData[index]
            if(uD.isStop){
                // console.log("Bot stopped")
                // while(uD.isStop){
                //     await sleep(10)
                //     let idx = userData.findIndex((item)=>{return item.id==userId})
                //     if(idx==-1) throw new Error("Invalid User")
                //     uD = userData[idx]
                // }
                // console.log("Bot restarted")
                await sleep(30)
                continue;
            }
            if(!uD.isAble){
                // console.log("You can't access this service. Please buy accessibility\n")
                // while(!uD.isAble){
                //     await sleep(10)
                //     let idx = userData.findIndex((item)=>{return item.id==userId})
                //     if(idx==-1) throw new Error("Invalid User")
                //     uD = userData[idx]
                // }
                // console.log("Wow, You can access From NOW")
                await sleep(30)
                continue;
            }
            // if(copyCount == adminData.transactionLimit){
            //     // console.log(`You reached Transaction Limit(${admin.transactionLimit})`)
            //     // while(new Date().getTime() < lastTime + DAY) await sleep(100)
            //     if(new Date().getTime() < lastTime + DAY){
            //         await sleep(5)
            //         continue
            //     }else{
            //         copyCount = 0
            //         lastTime = new Date().getTime()
            //     }
            // }
            if(new Date().getTime() >= lastTime + DAY){
                copyCount = 0
                lastTime = new Date().getTime()
            }else if(copyCount == adminData.transactionLimit){
                await sleep(200)
                continue
            }
            let conn = new Connection(uD.rpcNode!=undefined&&uD.rpcNode!=null&&uD.rpcNode!=""?uD.rpcNode:adminData.defaultRpcNode)
            try{
                let signatures = await conn.getSignaturesForAddress(uD.target, {limit: 5})
                if(firstRun==0){
                    lastTx = signatures[0].signature
                }
                let i = 0
                for(let item of signatures){
                    if(item.signature===lastTx && item.err==null) break;
                    i++
                }
                if(i>=1){
                    lastTx = signatures[i-1].signature
                    if(signatures[i-1].err==null){
                        try{
                            let parsedContent = await parseTransaction(lastTx, uD.target)                    
                            if(parsedContent.feePayer==uD.target && parsedContent.type=="SWAP"){
                                // console.log("New Activity of TARGET : ", parsedContent.description)
                                try{
                                    let swapContent = parsedContent.events.swap
                                    let inputMint = swapContent.nativeInput!=null ? NATIVE_MINT.toString() : swapContent.tokenInputs[0].mint
                                    let outputMint = swapContent.nativeOutput!=null ? NATIVE_MINT.toString() : swapContent.tokenOutputs[0].mint
                                    let amount = swapContent.nativeInput!=null ? swapContent.nativeInput.amount/(10**9) : swapContent.tokenInputs[0].rawTokenAmount.tokenAmount/(10**swapContent.tokenInputs[0].rawTokenAmount.decimals)
                                    if(inputMint==NATIVE_MINT.toString() || inputMint==USDC.toString() || outputMint==NATIVE_MINT.toString() || outputMint==USDC.toString()){
                                        let {txid, description} = await swap(uD, inputMint, outputMint, amount)
                                        let explorer_link = "https://solscan.io/tx/"
                                        let message = parsedContent.description + "\r\n\r\n" + description + "\r\n\r\n" + "Today's transaction count   :   " + (copyCount+1)
                                        await bot.telegram.sendMessage(userId, message, {parse_mode: "HTML", reply_markup: {inline_keyboard: [[{text:"-> Target <-", url: explorer_link+lastTx}, {text:"-> Me <-", url: explorer_link+txid}]]}})
                                        copyCount++
                                    }
                                }catch(err){
                                    // console.log(err)
                                }
                            }else
                            if(parsedContent.feePayer==uD.target && parsedContent.type=="SWAP_MANUAL"){
                                // console.log("New Activity of TARGET : ", parsedContent.description)
                                try{
                                    if(parsedContent.inputToken.mint==NATIVE_MINT.toString() || parsedContent.inputToken.mint==USDC.toString() || parsedContent.outputToken.mint==NATIVE_MINT.toString() || parsedContent.outputToken.mint==USDC.toString()){
                                        let {txid, description} = await swap(uD, parsedContent.inputToken.mint, parsedContent.outputToken.mint, parsedContent.inputToken.amount)
                                        let explorer_link = "https://solscan.io/tx/"
                                        let message = parsedContent.description + "\r\n\r\n" + description + "\r\n\r\n" + "Today's transaction count   :   " + (copyCount+1)
                                        await bot.telegram.sendMessage(userId, message, {parse_mode: "HTML", reply_markup: {inline_keyboard: [[{text:"-> Target <-", url: explorer_link+lastTx}, {text:"-> Me <-", url: explorer_link+txid}]]}})
                                        copyCount++;
                                    }
                                }catch(err){
                                    // console.log(err)
                                }
                            }
                        }catch(err){
                            // console.log(err)
                        }
                    }
                }
                await sleep(200)
                firstRun=1
            }catch(err){
                // console.log(err)
                await sleep(200)
                firstRun = 0
            }
        }
    }catch(err){

    }
}

bot.start(async (ctx) => {
    await ctx.reply("Welcome to the Trading Bot! This Bot will copy all trades of the target wallet. \n Start by setting your secret key. Make a unique wallet, then type '/secret_key <pastePrivateKeyHere>' to establish your wallet.  \n Then, type '/target <pasteTargetWalletHere>' to set your taget wallet. \n  Next, type '/sol_amount 1' to set your trade to be 1 Sol. Change 1 to whichever number you desire. \nUSDC is the same as Sol. You only should use /usdc_amount \n  Finally, type /bot_start to begin the bot! At any time, type /status to view the current status of the bot  ");
});

bot.telegram.setMyCommands([
    {command: "secret_key", description: "set your wallet - secret key"},
    {command: "target", description: "set your target wallet"},
    // {command: "percent", description: "set percent of copy amount"},
    {command: "rpc_node", description: "set your private rpc node"},
    {command: "sol_amount", description: "set Sol amount you swap in a transaction"},
    {command: "usdc_amount", description: "set USDC amount you swap in a transaction"},
    {command: "bot_start", description: "create a new copy trading service or restart"},
    {command: "stop", description: "stop the bot"},
    {command: "buy_ticket", description: "postpone accessibility time"},
    {command: "status", description: "show your data"},
    {command: "bot_status", description: "show bot information"},
    {command: "close", description: "close the bot"},
])
  
bot.command("secret_key", async (ctx) => {
    try {
        let owner = ctx.update.message.from.id;
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/);
        if(texts.length==1){
            await ctx.reply("Please try /secret_key <your_secret_key>.")
            return
        }
        let secretKey = Keypair.fromSecretKey(bs58.decode(texts[1]));
        let index = userData.findIndex((item) => {
            return item.id == owner;
        });
        if (index != -1) {
            userData[index] = { ...userData[index], secretKey: secretKey };
        } else {
            userData.push({...UserDataTemplate, id: owner, secretKey: secretKey });
        }
        await ctx.reply("Secret key registered successfully.");
    } catch (err) {
        // console.log(err); // Log the error to the console
        await ctx.reply("Something went wrong. Please check the format of your secret key and retry. Error: " + err.message);
    }
 });
  
// bot.command("percent", async(ctx)=>{
//     try{
//         let owner = ctx.update.message.from.id;
//         let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/);
//         if(texts.length==1){
//             await ctx.reply("Please try /percent <copy_percent>.")
//             return
//         }
//         let percent = Number(texts[1])
//         if(percent<0 || isNaN(percent)){
//             throw new Error("Less than 0 or Invalid Num Format.")
//         }
//         let index = userData.findIndex((item) => {
//             return item.id == owner;
//         });
//         if (index != -1) {
//             userData[index] = { ...userData[index], percent: percent };
//         } else {
//             userData.push({...UserDataTemplate, id: owner, percent: percent });
//         }
//         await ctx.reply("Copy percent registered successfully.")
//     }catch(err){
//         console.log(err)
//         await ctx.reply("Something went wrong. Please check the format of your percent value and retry.\nError: " + err.message)
//     }
// })

bot.command("sol_amount", async(ctx)=>{
    try{
        let owner = ctx.update.message.from.id
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            await ctx.reply("Please try /sol_amount <sol amount you will swap in a transaction>.")
            return
        }
        let solAmount = Number(texts[1])
        if(solAmount<0 || isNaN(solAmount)){
            throw new Error("Less than 0 or Invalid Num Format.")
        }
        let index = userData.findIndex((item)=>{
            return item.id == owner
        })
        if (index != -1) {
            userData[index] = { ...userData[index], solAmount: solAmount };
        } else {
            userData.push({...UserDataTemplate, id: owner, solAmount: solAmount });
        }
        await ctx.reply("Sol amount registered successfully.")
    }catch(err){
        await ctx.reply("Something went wrong. Please check the format of your sol amount value and retry.\nError: "+err.message)
    }
})

bot.command("usdc_amount", async(ctx)=>{
    try{
        let owner = ctx.update.message.from.id
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            await ctx.reply("Please try /usdc_amount <USDC amount you will swap in a transaction>.")
            return
        }
        let usdcAmount = Number(texts[1])
        if(usdcAmount<0 || isNaN(usdcAmount)){
            throw new Error("Less than 0 or Invalid Num Format.")
        }
        let index = userData.findIndex((item)=>{
            return item.id == owner
        })
        if (index != -1) {
            userData[index] = { ...userData[index], usdcAmount: usdcAmount };
        } else {
            userData.push({...UserDataTemplate, id: owner, usdcAmount: usdcAmount });
        }
        await ctx.reply("USDC amount registered successfully.")
    }catch(err){
        await ctx.reply("Something went wrong. Please check the format of your sol amount value and retry.\nError: "+err.message)
    }
})

bot.command("target", async (ctx) => {
    try {
        let owner = ctx.update.message.from.id;
         let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/);
        if(texts.length==1){
            await ctx.reply("Please try /target <your_target_wallet>.")
            return
        }
        let targetAddress = texts[1];
        const target = new PublicKey(targetAddress);
        let index = userData.findIndex((item) => {
            return item.id == owner;
        });
        if (index != -1) {
            userData[index] = { ...userData[index], target: target };
        } else {
            userData.push({...UserDataTemplate, id: owner, target: target });
        }
        await ctx.reply("Target wallet registered successfully.");
    } catch (err) {
        await ctx.reply("Something went wrong. Please check the format of your target and retry. Error: "+err.message);
    }
})

bot.command("rpc_node", async (ctx) => {
    try {
        let owner = ctx.update.message.from.id;
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/);
        let rpcNode = ""
        if(texts.length>=1){
            rpcNode = texts[1];
        }
        let index = userData.findIndex((item) => {return item.id == owner;});
        if (index != -1) {
            userData[index] = { ...userData[index], rpcNode: rpcNode };
        } else {
            userData.push({...UserDataTemplate, id: owner, rpcNode: rpcNode });
        }
        if(rpcNode===""){
            await ctx.reply("Default node registered.");
        }else{
            await ctx.reply("RPC Node registered successfully")
        }
    } catch (err) {
        await ctx.reply("Something went wrong. Please check the format of your rpc node and retry. Error: "+err.message);
    }
})

bot.command("bot_start", async(ctx)=>{
    try{
        let owner = ctx.update.message.from.id
        let index = userData.findIndex((item)=>{return item.id==owner})
        if(index==-1){
            await ctx.reply("You are not eligible. Please purchase subscription or NFT and $CULT as required. ")
            return
        }
        if(userData[index].secretKey==undefined || userData[index].secretKey==null){
            await ctx.reply("Invalid Secret Key.")
            return
        }
        if(userData[index].target==undefined || userData[index].target==null){
            await ctx.reply("Invalid Target")
            return
        }
        // if(userData[index].percent==undefined || userData[index].percent==null || userData[index].percent==0){
        //     await ctx.reply("Invalid Percent Amount")
        //     return
        // }
        if(userData[index].solAmount==undefined || userData[index].solAmount==null || userData[index].solAmount==0){
            await ctx.reply("Invalid Sol Amount")
            return
        }
        if(userData[index].usdcAmount==undefined || userData[index].usdcAmount==null || userData[index].usdcAmount==0){
            await ctx.reply("Invalid USDC Amount")
            return
        }
        if(userData[index].isStop!=undefined && userData[index].isStop==false){
            await ctx.reply("Already started")
            return
        }
        userData[index] = {...userData[index], isStop: false}
        checkAccessibilityDuration(owner)
        mainService(owner)
        await ctx.reply("Bot started")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Please retry"+err.message)
    }
})

bot.command('buy_ticket', async(ctx)=>{
    try{
        let userId = ctx.update.message.from.id
        let index = userData.findIndex((item)=>{return item.id==userId})
        if(index == -1){
            await ctx.reply("You didn't register")
            return
        }
        let lastTime = await buyAccessibility(userId)
        await ctx.reply("Success, You can access this bot until ", new Date(lastTime).toString())
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Please check your wallet status and retry. Error: "+err.message)
    }
})

bot.command('stop', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.id
        let index = userData.findIndex((item)=>{return item.id==owner})
        if(index == -1){
            await ctx.reply("You didn't register")
            return
        }
        if(userData[index].isStop==undefined || userData[index].isStop){
            await ctx.reply("Not started")
            return
        }
        userData[index] = {...userData[index], isStop: true}
        await ctx.reply("Bot stopped")
    }catch(err){
        await ctx.reply("Something went wrong. Please retry."+err.message)
    }
})

bot.command('close', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.id
        let index = userData.findIndex((item)=>{return item.id==owner})
        if(index == -1){
            await ctx.reply("You didn't register")
            return
        }
        userData[index] = {...userData[index], isStop: false}
        userData.splice(index, 1)
        await ctx.reply("All your data was removed.")
    }catch(err){
        await ctx.reply("Something went wrong. Please retry."+err.message)
    }
})

bot.command('status', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.id
        let index = userData.findIndex((item)=>{return item.id==owner})
        if(index == -1){
            await ctx.reply("You didn't register")
            return
        }
        let uD = userData[index]
        // await ctx.reply(JSON.stringify({
        //     id: uD.id,
        //     publicKey: uD.secretKey!=undefined&&uD.secretKey!=null ? uD.secretKey.publicKey.toBase58() : "No",
        //     target: uD.target!=undefined&&uD.target!=null ? uD.target.toBase58() : "No",
        //     percent: uD.percent!=undefined&&uD.percent!=null ? uD.percent + "%" : "0",
        // }))
        let message = `<b>Your address   :  </b>${uD.secretKey!=undefined&&uD.secretKey!=null ? (uD.secretKey.publicKey.toBase58()+(adminData.allowList.findIndex((item)=>item==uD.secretKey.publicKey.toBase58())!=-1 ? "\n<u>You are whitelisted</u>" : "")) : "No"}\r\n\r\n<b>Target   :   </b>${uD.target!=undefined&&uD.target!=null ? uD.target.toBase58() : "No"}\r\n\r\n<b>Sol   :   </b>${uD.solAmount!=undefined&&uD.solAmount!=null ? uD.solAmount + " SOL" : "0"}\r\n\r\n<b>USDC   :   </b>${uD.usdcAmount!=undefined&&uD.usdcAmount!=null ? uD.usdcAmount + " USDC" : "0"}\r\n\r\n<b>RPC Node     :    </b>${uD.rpcNode!=undefined&&uD.rpcNode!=null&&uD.rpcNode!="" ? uD.rpcNode : "Default Node"}\r\n\r\n${uD.isStop ? "Bot was stopped" : "Bot is working now"}`
        if(uD.isStop==false){
            message += `\r\n\r\n${uD.isAble?"You can access" : "You are not allowed"}\r\n\r\nAccessibility Limit    :   ${uD.GlobalAccessibilityEndTime!=undefined&&uD.GlobalAccessibilityEndTime!=null&&uD.GlobalAccessibilityEndTime!=0 ? new Date(uD.GlobalAccessibilityEndTime).toString() : "No"}`
        }
        await ctx.reply(message,{parse_mode: "HTML"})
    }catch(err){
        await ctx.reply("Something went wrong. Please retry."+err.message)
    }
})


bot.command('bot_status', async(ctx)=>{
    try{
        let message = `Cult Amount for Allowance: ${adminData.minCultAmountForAllow} $CULT\n\nTreasury Wallet: ${adminData.treasuryWallet.toBase58()}\n\nFee:\n\t\t\tToken -> ${adminData.fee.mint.toBase58()==NATIVE_MINT.toBase58()?"SOL":adminData.fee.mint.toBase58()}\n\t\t\tFee Amount -> ${adminData.fee.feeAmount}\n\t\t\tDuration  ->  ${adminData.fee.duration==YEAR?"A YEAR":adminData.fee.duration==MONTH?"A MONTH":adminData.fee.duration==WEEK?"A WEEK":adminData.fee.duration==DAY?"A DAY":adminData.fee.duration+"ms"}\n\nTransaction Limit: ${adminData.transactionLimit}\n\nTransaction Fee: ${adminData.transactionFee} $CULT`
        if(adminData.allowList.length>0){
            message += "\n\nWhitelisted wallets: "
            for(let item of adminData.allowList){
                message += `\n\t\t\t`+item
            }
        }
        let userNum = userData.length
        let liveNum = 0
        for(let item of userData){
            if(item.isStop==false && item.isAble==true){
                liveNum++
            }
        }
        message += `\r\n\r\nRegistered User: ${userNum}\nLive User:${liveNum}`
        await ctx.reply(message)
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})



bot.command('save', async(ctx) => {
    try {
        let owner = ctx.update.message.from.username;
        // console.log('Owner:', owner)

if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");

        // Generate a new encryption key
        const newEncryptionKey = crypto.randomBytes(32);
        
        const fileName = "./infrastructure.json";
        fs.writeFile(fileName, encrypt(JSON.stringify({userData: userData.map(item => {
            return {...item, secretKey: item.secretKey != undefined && item.secretKey != null ? bs58.encode(item.secretKey.secretKey) : ""}
        })}), newEncryptionKey), () => {});

        // Send the new encryption key to the user as a hex string
        await ctx.reply("Saved! Your encryption key: " + newEncryptionKey.toString('hex'));
    } catch (err) {
        await ctx.reply("Something went wrong. Error: " + err.message);
    }
});

bot.command('load', async(ctx) => {
    try {
        let owner = ctx.update.message.from.username;
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");

        // Get the user's provided encryption key from the message text
        const userProvidedKey = ctx.update.message.text.split(' ')[1];
        const userEncryptionKey = Buffer.from(userProvidedKey, 'hex');

        const fileName = "./infrastructure.json";
        const rawData = fs.readFileSync(fileName);
        const decryptedData = decrypt(rawData.toString(), userEncryptionKey);
        const infJson = JSON.parse(decryptedData);
        userData = infJson.userData.map((item)=>{
            return {
                ...item,
                target: item.target!=undefined&&item.target!=null ? new PublicKey(item.target) : null,
                secretKey: item.secretKey!=undefined&&item.secretKey!="" ? Keypair.fromSecretKey(bs58.decode(item.secretKey)) : null,
                // percent: item.percent!=undefined&&item.percent!=null ? Number(item.percent) : 0,
                solAmount: item.solAmount!=undefined&&item.solAmount!=null ? Number(item.solAmount) : 0,
                usdcAmount: item.usdcAmount!=undefined&&item.usdcAmount!=null ? Number(item.usdcAmount) : 0,
                rpcNode: item.rpcNode!=undefined&&item.rpcNode!=null ? item.rpcNode : "",
                isStop: item.isStop!=undefined&&item.isStop!=null?item.isStop : true,
                isAble: false,
                GlobalAccessibilityEndTime: item.GlobalAccessibilityEndTime!=undefined&&item.GlobalAccessibilityEndTime!=null ? Number(item.GlobalAccessibilityEndTime) : 0
            }
        })
        for(let user of userData){
            if(user.isStop==false){
                checkAccessibilityDuration(user.id)
                await sleep(0.175)
                mainService(user.id)
                await sleep(0.175)
            }
        }
        await ctx.reply("Success!")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('save_admin_data', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        const fileName = "./infrastructure_admin.json"
        fs.writeFile(fileName, JSON.stringify({
            ...adminData,
            treasuryWallet: adminData.treasuryWallet.toBase58(),
            fee:{
                ...adminData.fee,
                mint: adminData.fee.mint.toBase58(),
            }
        }),()=>{})
        await ctx.reply("Saved!")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('load_admin_data', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        const fileName = "./infrastructure_admin.json"
        const rawData = fs.readFileSync(fileName)
        const infJson = JSON.parse(rawData.toString())
        adminData = {
            ...infJson,
            treasuryWallet: new PublicKey(infJson.treasuryWallet),
            fee: {
                ...infJson.fee,
                mint: new PublicKey(infJson.fee.mint)
            },
            defaultRpcNode: infJson.defaultRpcNode!=undefined&&infJson.defaultRpcNode!=null&&infJson.defaultOptions!=""?infJson.defaultRpcNode:RPC_NODE
        }
        await ctx.reply("Success!")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_transaction_fee', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            await ctx.reply("Please try /admin_transaction_fee <transaction_fee>.")
            return
        }
        let transactionFee = Number(texts[1])
        adminData.transactionFee = transactionFee
        await ctx.reply("Success")
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_treasury', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            await ctx.reply("Please try /admin_treasury <treasury_wallet>.")
            return
        }        
        adminData.treasuryWallet = new PublicKey(texts[1])
        await ctx.reply("Success")
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_rpc_node', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        let rpcNode = RPC_NODE
        let prevNode = adminData.defaultRpcNode
        if(texts.length>1){
            // await ctx.reply("Please try /admin_rpc_node <default_rpc_node>.")
            // return
            rpcNode = texts[1]
        }        
        adminData.defaultRpcNode = rpcNode
        await ctx.reply(`Success\r\n\r\nPrevious Node   :  ${prevNode}\r\n\r\nCurrent Node   :   ${adminData.defaultRpcNode}`)
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_transaction_limit', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            await ctx.reply("Please try /admin_transaction_limit <transaction_limit>.")
            return
        }
        let transactionLimit = Number(texts[1])
        if(Number(transactionLimit) < 0 || isNaN(transactionLimit)) throw new Error("Invalid Number")
        adminData.transactionLimit = transactionLimit
        await ctx.reply("Success")
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_allow_amount', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            await ctx.reply("Please try /admin_allow_amount <allow_amount>.")
            return
        }
        let allowAmount = Number(texts[1])
        if(Number(transactionLimit) < 0 || isNaN(transactionLimit)) throw new Error("Invalid Number")
        adminData.allowAmount = allowAmount
        await ctx.reply("Success")
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_whitelist', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            // await ctx.reply("Please try /admin_whitelist <whitelisted wallets>.")
            adminData.allowList = []
            await ctx.reply("Success! There is no whitelisted wallets")
            return
        }
        texts.splice(0,1)
        for(let item of texts){
            try{
                new PublicKey(item)
            }catch(err){
                throw new Error(`${item} is non-base58 character`)
            }
        }
        adminData.allowList = texts
        await ctx.reply("Success")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_whitelist_add', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            // await ctx.reply("Please try /admin_whitelist <whitelisted wallets>.")
            adminData.allowList = []
            await ctx.reply("Success! There is no whitelisted wallets")
            return
        }
        texts.splice(0,1)
        for(let item of texts){
            try{
                new PublicKey(item)
            }catch(err){
                throw new Error(`${item} is non-base58 character`)
            }
        }
        for(let item of texts){
            if(adminData.allowList.findIndex((one)=>{return one==item})==-1){
                adminData.allowList.push(item)
            }
        }
        await ctx.reply("Success")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_whitelist_remove', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length==1){
            // await ctx.reply("Please try /admin_whitelist <whitelisted wallets>.")
            adminData.allowList = []
            await ctx.reply("Success! There is no whitelisted wallets")
            return
        }
        texts.splice(0,1)
        for(let item of texts){
            try{
                new PublicKey(item)
            }catch(err){
                throw new Error(`${item} is non-base58 character`)
            }
        }
        for(let item of texts){
            let index = adminData.allowList.findIndex((one)=>{return one==item})
            if(index != -1){
                adminData.allowList.splice(index, 1)
            }
        }
        await ctx.reply("Success")
    }catch(err){
        // console.log(err)
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('admin_fee', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let texts = ctx.update.message.text.split(/[ ,\r\n\t]+/)
        if(texts.length!=4){
            await ctx.reply("Please try /admin_fee fee_token fee_amount fee_duration")
        }
        adminData.fee={
            mint: texts[1].toLocaleLowerCase()=="sol" ? NATIVE_MINT : new PublicKey(texts[1]),
            feeAmount: Number(texts[2]),
            duration: texts[3].toLocaleLowerCase()=="year" ? YEAR : texts[3].toLocaleLowerCase()=="month" ? MONTH : texts[3].toLocaleLowerCase()=="week" ? WEEK : texts[3].toLocaleLowerCase()=="day" ? DAY : Number(texts[3])
        }
        await ctx.reply("Success")
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.command('hash_list', async(ctx)=>{
    try{
        let owner = ctx.update.message.from.username
if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
        let message = 'Total   :   ' + hashList.length
        let i = 0
        if(hashList.length>10){
            for(let i=0;i<5;i++){
                message += "\r\n" + hashList[i]
            }
            message += "\r\n....     ...."
            for(let i=hashList.length-5;i<hashList.length;i++){
                message += "\r\n" + hashList[i]
            }
        }else{
            for(let item of hashList){
                message += "\r\n" + item
            }
        }
        await ctx.reply(message)
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

const { message } = require('telegraf/filters');
bot.on(message('document'), async(ctx)=>{
    try{
        if(ctx.update.message.document.file_name=='hash_list.json'){
            let owner = ctx.update.message.from.username
            if (!adminUsernames.includes(owner)) throw new Error("You are not administrator");
            let fileInfo = await (await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${ctx.update.message.document.file_id}`)).json()
            let file = await (await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`)).json()
            for(let item of file){
                try{
                    new PublicKey(item)
                }catch(err){
                    throw new Error(`${item} is non-base58 character`)
                }
            }
            hashList = file
            await ctx.reply("Hashlist updated.")
        }else{
            await ctx.reply("Hi")
        }
    }catch(err){
        await ctx.reply("Something went wrong. Error: "+err.message)
    }
})

bot.launch()