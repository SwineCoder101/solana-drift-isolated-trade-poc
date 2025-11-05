"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenOrders = void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const spl_token_1 = require("@solana/spl-token");
const __1 = require("..");
class OpenOrders {
    pubkey;
    account;
    market;
    delegate;
    constructor(pubkey, account, market) {
        this.pubkey = pubkey;
        this.account = account;
        this.market = market;
    }
    /// high-level API
    static async load(pubkey, market, client) {
        client ??= market?.client;
        if (!client)
            throw new Error('provide either market or client');
        const account = await client.program.account.openOrdersAccount.fetch(pubkey);
        if (!market) {
            market = await __1.Market.load(client, account.market);
        }
        return new OpenOrders(pubkey, account, market);
    }
    /**
     * Try loading the OpenOrders account associated with a Market
     * @param market
     * @param owner optional if configured already on the Market's client
     * @param indexer optional, pass in to speed up fetch
     * @returns null if the user does not have an OpenOrders account for this market
     */
    static async loadNullableForMarketAndOwner(market, owner, indexer) {
        indexer ??= await __1.OpenOrdersIndexer.loadNullable(market.client, owner);
        if (!indexer)
            return null;
        const ooPks = indexer.account.addresses;
        const ooAccs = await market.client.program.account.openOrdersAccount.fetchMultiple(ooPks);
        const ooIndex = ooAccs.findIndex((o) => o?.market.equals(market.pubkey));
        if (ooIndex == -1)
            return null;
        const ooPk = ooPks[ooIndex];
        const ooAcc = ooAccs[ooIndex];
        // note: ooPk & ooAcc most certainly will always be defined here, due to the index check
        return ooPk && ooAcc && new OpenOrders(ooPk, ooAcc, market);
    }
    async reload() {
        // Need to reload orderbooks because not all information about orders, like
        // size, is stored on the open orders account. Do all fetches together to
        // ensure they are synced to the same slot.
        const [bidsAi, asksAi, ooAi] = await this.market.client.connection.getMultipleAccountsInfo([
            this.market.account.bids,
            this.market.account.asks,
            this.pubkey,
        ]);
        this.market.bids = new __1.BookSide(this.market, this.market.account.bids, __1.BookSide.decodeAccountfromBuffer(bidsAi.data), __1.SideUtils.Bid);
        this.market.asks = new __1.BookSide(this.market, this.market.account.asks, __1.BookSide.decodeAccountfromBuffer(asksAi.data), __1.SideUtils.Ask);
        this.account = this.market.client.program.coder.accounts.decode('openOrdersAccount', ooAi.data);
        return this;
    }
    getBalanceNative() {
        const { asksBaseLots, bidsQuoteLots, baseFreeNative, quoteFreeNative, lockedMakerFees, } = this.account.position;
        const { baseLotSize, quoteLotSize } = this.market.account;
        // TODO count in lots to save compute
        const base = asksBaseLots.mul(baseLotSize).iadd(baseFreeNative);
        const quote = bidsQuoteLots
            .mul(quoteLotSize)
            .iadd(quoteFreeNative)
            .iadd(lockedMakerFees);
        if (this.market.eventHeap) {
            for (const event of this.market.eventHeap.parsedEvents()) {
                switch (event.eventType) {
                    case __1.EventType.Fill: {
                        const { maker, quantity, price, takerSide } = event;
                        if (maker.equals(this.account.owner)) {
                            const baseNative = quantity.mul(baseLotSize);
                            const quoteNative = quantity.mul(price).imul(quoteLotSize);
                            const quoteFeesNative = this.market.makerFeeFloor(quoteNative);
                            if (takerSide === 1) {
                                // buy
                                base.iadd(baseNative);
                                quote.isub(quoteNative.iadd(quoteFeesNative));
                            }
                            else {
                                // sell
                                base.isub(baseNative);
                                quote.iadd(quoteNative.isub(quoteFeesNative));
                            }
                        }
                        continue;
                    }
                    case __1.EventType.Out: {
                        // out events don't change balances
                        continue;
                    }
                }
            }
        }
        return [base, quote];
    }
    setDelegate(delegate) {
        this.delegate = delegate;
        return this;
    }
    async placeOrder(order) {
        // derive token account
        const mint = order.side.bid
            ? this.market.account.quoteMint
            : this.market.account.baseMint;
        const userTokenAccount = await (0, __1.getAssociatedTokenAddress)(mint, this.market.client.walletPk);
        // TODO: derive wrap sol instruction
        const remainingAccounts = new Set();
        const bookSide = order.side.bid ? this.market.asks : this.market.bids;
        if (bookSide &&
            !order.orderType?.postOnly &&
            !order.orderType?.postOnlySlide) {
            for (const order of bookSide.items()) {
                remainingAccounts.add(order.leafNode.owner.toBase58());
                if (remainingAccounts.size >= 3)
                    break;
            }
        }
        const [placeIx] = await this.placeOrderIx(order, userTokenAccount, [...remainingAccounts].map((a) => new web3_js_1.PublicKey(a)));
        const additionalSigners = this.delegate ? [this.delegate] : [];
        return this.market.client.sendAndConfirmTransaction([placeIx], {
            additionalSigners,
        });
    }
    async cancelOrder(order) {
        const ixs = [];
        if ('clientOrderId' in order) {
            const id = new anchor_1.BN(order.clientOrderId);
            const [ix] = await this.cancelOrderByClientIdIx(id);
            ixs.push(ix);
        }
        else {
            const id = order.leafNode.key;
            const [ix] = await this.cancelOrderByIdIx(id);
            ixs.push(ix);
        }
        const additionalSigners = this.delegate ? [this.delegate] : [];
        return this.market.client.sendAndConfirmTransaction(ixs, {
            additionalSigners,
        });
    }
    async cancelAllOrders(side) {
        const [cancelIx] = await this.cancelAllOrdersIx(side);
        const { baseMint, quoteMint } = this.market.account;
        const owner = this.market.client.walletPk;
        const payer = this.delegate?.publicKey ?? owner;
        const ataIxs = [];
        const baseATA = await (0, __1.getAssociatedTokenAddress)(baseMint, owner);
        ataIxs.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(payer, baseATA, owner, baseMint));
        const quoteATA = await (0, __1.getAssociatedTokenAddress)(quoteMint, owner);
        ataIxs.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(payer, quoteATA, owner, quoteMint));
        const referrer = this.market.client.referrerWallet;
        let referrerATA = null;
        if (referrer) {
            referrerATA = await (0, __1.getAssociatedTokenAddress)(quoteMint, referrer);
            ataIxs.push((0, spl_token_1.createAssociatedTokenAccountIdempotentInstruction)(payer, referrerATA, referrer, quoteMint));
        }
        const [settleIx] = await this.settleFundsIx(baseATA, quoteATA, referrerATA, payer);
        // TODO: derive unwrap sol instruction
        const additionalSigners = this.delegate ? [this.delegate] : [];
        return this.market.client.sendAndConfirmTransaction([cancelIx, ...ataIxs, settleIx], { additionalSigners });
    }
    *items() {
        const { bids, asks } = this.market;
        if (!bids || !asks)
            throw new Error('requires OrderBook of Market to be loaded');
        for (const slot of this.account.openOrders) {
            if (slot.isFree)
                continue;
            let gen;
            switch (slot.sideAndTree) {
                case 0:
                    gen = bids.fixedItems();
                    break;
                case 1:
                    gen = asks.fixedItems();
                    break;
                case 2:
                    gen = bids.oraclePeggedItems();
                    break;
                case 3:
                    gen = asks.oraclePeggedItems();
                    break;
            }
            inner: for (const order of gen) {
                if (order.leafNode.key.eq(slot.id)) {
                    yield order;
                    break inner;
                }
            }
        }
    }
    toPrettyString() {
        const oo = this.account;
        let debug = `OO: ${this.pubkey.toBase58()}\n`;
        debug += ` owner: ${oo.owner.toBase58()}\n`;
        debug += ` market: ${oo.market.toBase58()} (${(0, __1.nameToString)(this.market.account.name)})\n`;
        if (!oo.delegate.key.equals(web3_js_1.PublicKey.default))
            debug += ` delegate: ${oo.delegate.key.toBase58()}\n`;
        debug += ` accountNum: ${oo.accountNum}\n`;
        debug += ` version: ${oo.version}\n`;
        debug += ` bidsBaseLots: ${oo.position.bidsBaseLots.toString()}\n`;
        debug += ` bidsQuoteLots: ${oo.position.bidsQuoteLots.toString()}\n`;
        debug += ` asksBaseLots: ${oo.position.asksBaseLots.toString()}\n`;
        debug += ` baseFreeNative: ${oo.position.baseFreeNative.toString()}\n`;
        debug += ` quoteFreeNative: ${oo.position.quoteFreeNative.toString()}\n`;
        debug += ` lockedMakerFees: ${oo.position.lockedMakerFees.toString()}\n`;
        debug += ` referrerRebatesAvailable: ${oo.position.referrerRebatesAvailable.toString()}\n`;
        debug += ` penaltyHeapCount: ${oo.position.penaltyHeapCount.toString()}\n`;
        debug += ` makerVolume: ${oo.position.makerVolume.toString()}\n`;
        debug += ` takerVolume: ${oo.position.takerVolume.toString()}\n`;
        debug += ` orders:\n`;
        for (const order of this.items()) {
            debug += `  ${order.toPrettyString()}\n`;
        }
        if (this.market.eventHeap) {
            debug += ` events:\n`;
            for (const event of this.market.eventHeap.parsedEvents()) {
                switch (event.eventType) {
                    case __1.EventType.Fill: {
                        const { maker, quantity, price, takerSide } = event;
                        if (maker.equals(this.pubkey)) {
                            const fillBase = this.market.baseLotsToUi(quantity);
                            const fillPrice = this.market.priceLotsToUi(price);
                            debug += `  fill side=${takerSide === 1 ? 'Bid' : 'Ask'} qty=${fillBase} price=${fillPrice}\n`;
                        }
                        continue;
                    }
                    case __1.EventType.Out: {
                        const { owner } = event;
                        if (owner.equals(this.pubkey))
                            debug += `  out ${JSON.stringify(event)}\n`;
                        continue;
                    }
                }
            }
            debug += ` balance:\n`;
            const [base, quote] = this.getBalanceNative();
            debug += `  base: ${this.market.baseNativeToUi(base)}\n`;
            debug += `  quote: ${this.market.quoteNativeToUi(quote)}\n`;
        }
        return debug;
    }
    getBaseBalanceNative() {
        return this.account.position.asksBaseLots
            .mul(this.market.account.baseLotSize)
            .iadd(this.account.position.baseFreeNative);
    }
    getQuoteBalanceNative() {
        return this.account.position.bidsQuoteLots
            .mul(this.market.account.quoteLotSize)
            .iadd(this.account.position.quoteFreeNative)
            .iadd(this.account.position.lockedMakerFees);
    }
    getBaseBalanceUi() {
        return (Number(this.getBaseBalanceNative().toString()) /
            10 ** this.market.account.baseDecimals);
    }
    getQuoteBalanceUi() {
        return (Number(this.getQuoteBalanceNative().toString()) /
            10 ** this.market.account.quoteDecimals);
    }
    /// low-level API
    async placeOrderIx(order, userTokenAccount, remainingAccounts = []) {
        const priceLots = this.market.priceUiToLots(order.price);
        const maxBaseLots = this.market.baseUiToLots(order.size);
        const maxQuoteLotsIncludingFees = order.quoteLimit
            ? new anchor_1.BN(order.quoteLimit)
            : __1.I64_MAX_BN;
        const clientOrderId = new anchor_1.BN(order.clientOrderId || Date.now());
        const orderType = order.orderType ?? __1.PlaceOrderTypeUtils.Limit;
        const expiryTimestamp = new anchor_1.BN(order.expiryTimestamp ?? 0);
        const selfTradeBehavior = order.selfTradeBehavior ?? __1.SelfTradeBehaviorUtils.DecrementTake;
        const limit = order.matchLoopLimit ?? 16;
        const args = {
            side: order.side,
            priceLots,
            maxBaseLots,
            maxQuoteLotsIncludingFees,
            clientOrderId,
            orderType,
            expiryTimestamp,
            selfTradeBehavior,
            limit,
        };
        return await this.market.client.placeOrderIx(this.pubkey, this.market.pubkey, this.market.account, userTokenAccount, args, remainingAccounts, this.delegate);
    }
    async cancelAllOrdersIx(side) {
        return this.market.client.cancelAllOrdersIx(this.pubkey, this.account, this.market.account, 24, side, this.delegate);
    }
    async cancelOrderByIdIx(id) {
        return this.market.client.cancelOrderByIdIx(this.pubkey, this.account, this.market.account, id, this.delegate);
    }
    async cancelOrderByClientIdIx(id) {
        return this.market.client.cancelOrderByClientIdIx(this.pubkey, this.account, this.market.account, id, this.delegate);
    }
    async settleFundsIx(userBaseAccount, userQuoteAccount, referrerAccount, penaltyPayer) {
        return this.market.client.settleFundsIx(this.pubkey, this.account, this.market.pubkey, this.market.account, userBaseAccount, userQuoteAccount, referrerAccount, penaltyPayer, this.delegate);
    }
}
exports.OpenOrders = OpenOrders;
