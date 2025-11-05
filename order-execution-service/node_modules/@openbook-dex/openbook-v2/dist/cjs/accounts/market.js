"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Market = void 0;
const big_js_1 = __importDefault(require("big.js"));
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
const __1 = require("..");
const FEES_SCALE_FACTOR = new anchor_1.BN(1_000_000);
class Market {
    client;
    pubkey;
    account;
    minOrderSize;
    tickSize;
    quoteLotFactor;
    baseNativeFactor;
    quoteNativeFactor;
    /**
     * use async loadBids() or loadOrderBook() to populate bids
     */
    bids;
    /**
     * use async loadAsks() or loadOrderBook() to populate asks
     */
    asks;
    eventHeap;
    constructor(client, pubkey, account) {
        this.client = client;
        this.pubkey = pubkey;
        this.account = account;
        this.baseNativeFactor = new big_js_1.default(10).pow(-account.baseDecimals);
        this.quoteNativeFactor = new big_js_1.default(10).pow(-account.quoteDecimals);
        this.minOrderSize = new big_js_1.default(account.baseLotSize.toString()).mul(this.baseNativeFactor);
        this.quoteLotFactor = new big_js_1.default(account.quoteLotSize.toString()).mul(this.quoteNativeFactor);
        this.tickSize = new big_js_1.default(10)
            .pow(account.baseDecimals - account.quoteDecimals)
            .mul(new big_js_1.default(account.quoteLotSize.toString()))
            .div(new big_js_1.default(account.baseLotSize.toString()));
    }
    static async load(client, pubkey) {
        const account = await client.program.account.market.fetch(pubkey);
        return new Market(client, pubkey, account);
    }
    baseLotsToUi(lots) {
        return new big_js_1.default(lots.toString()).mul(this.minOrderSize).toNumber();
    }
    baseNativeToUi(native) {
        return new big_js_1.default(native.toString()).mul(this.baseNativeFactor).toNumber();
    }
    quoteLotsToUi(lots) {
        return new big_js_1.default(lots.toString()).mul(this.quoteLotFactor).toNumber();
    }
    quoteNativeToUi(native) {
        return new big_js_1.default(native.toString()).mul(this.quoteNativeFactor).toNumber();
    }
    priceLotsToUi(lots) {
        return new big_js_1.default(lots.toString()).mul(this.tickSize).toNumber();
    }
    baseUiToLots(uiAmount) {
        return (0, __1.toNative)(uiAmount, this.account.baseDecimals).div(this.account.baseLotSize);
    }
    quoteUiToLots(uiAmount) {
        return (0, __1.toNative)(uiAmount, this.account.quoteDecimals).div(this.account.quoteLotSize);
    }
    priceUiToLots(uiAmount) {
        return (0, __1.toNative)(uiAmount * Number(this.account.baseLotSize.toString()), this.account.quoteDecimals).div(new anchor_1.BN(Math.pow(10, this.account.baseDecimals)).imul(this.account.quoteLotSize));
    }
    makerFeeFloor(quoteNative) {
        return quoteNative.mul(this.account.makerFee).div(FEES_SCALE_FACTOR);
    }
    async loadBids() {
        const bidsAi = await this.client.connection.getAccountInfo(this.account.bids);
        this.bids = new __1.BookSide(this, this.account.bids, __1.BookSide.decodeAccountfromBuffer(bidsAi.data), __1.SideUtils.Bid);
        return this.bids;
    }
    async loadAsks() {
        const asksAi = await this.client.connection.getAccountInfo(this.account.asks);
        this.asks = new __1.BookSide(this, this.account.asks, __1.BookSide.decodeAccountfromBuffer(asksAi.data), __1.SideUtils.Ask);
        return this.asks;
    }
    async loadEventHeap() {
        const eventHeap = (await this.client.program.account.eventHeap.fetch(this.account.eventHeap));
        this.eventHeap = new __1.EventHeap(this.account.eventHeap, eventHeap, this);
        return this.eventHeap;
    }
    async loadOrderBook() {
        await Promise.all([this.loadBids(), this.loadAsks()]);
        return this;
    }
    toPrettyString() {
        const mkt = this.account;
        let debug = `Market: ${(0, __1.nameToString)(mkt.name)}\n`;
        debug += ` authority: ${mkt.marketAuthority.toBase58()}\n`;
        debug += ` collectFeeAdmin: ${mkt.collectFeeAdmin.toBase58()}\n`;
        if (!mkt.openOrdersAdmin.key.equals(web3_js_1.PublicKey.default))
            debug += ` openOrdersAdmin: ${mkt.openOrdersAdmin.key.toBase58()}\n`;
        if (!mkt.consumeEventsAdmin.key.equals(web3_js_1.PublicKey.default))
            debug += ` consumeEventsAdmin: ${mkt.consumeEventsAdmin.key.toBase58()}\n`;
        if (!mkt.closeMarketAdmin.key.equals(web3_js_1.PublicKey.default))
            debug += ` closeMarketAdmin: ${mkt.closeMarketAdmin.key.toBase58()}\n`;
        debug += ` baseMint: ${mkt.baseMint.toBase58()}\n`;
        debug += ` quoteMint: ${mkt.quoteMint.toBase58()}\n`;
        debug += ` marketBaseVault: ${mkt.marketBaseVault.toBase58()}\n`;
        debug += ` marketQuoteVault: ${mkt.marketQuoteVault.toBase58()}\n`;
        if (!mkt.oracleA.key.equals(web3_js_1.PublicKey.default)) {
            debug += ` oracleConfig: { confFilter: ${mkt.oracleConfig.confFilter}, maxStalenessSlots: ${mkt.oracleConfig.maxStalenessSlots.toString()} }\n`;
            debug += ` oracleA: ${mkt.oracleA.key.toBase58()}\n`;
        }
        if (!mkt.oracleB.key.equals(web3_js_1.PublicKey.default))
            debug += ` oracleB: ${mkt.oracleB.key.toBase58()}\n`;
        debug += ` bids: ${mkt.bids.toBase58()}\n`;
        const bb = this.bids?.best();
        if (bb) {
            debug += `  best: ${bb.price} ${bb.size} ${bb.leafNode.owner.toBase58()}\n`;
        }
        debug += ` asks: ${mkt.asks.toBase58()}\n`;
        const ba = this.asks?.best();
        if (ba) {
            debug += `  best: ${ba.price} ${ba.size} ${ba.leafNode.owner.toBase58()}\n`;
        }
        debug += ` eventHeap: ${mkt.eventHeap.toBase58()}\n`;
        if (this.eventHeap) {
            let fillEvents = 0;
            let outEvents = 0;
            for (const event of this.eventHeap.parsedEvents()) {
                switch (event.eventType) {
                    case __1.EventType.Fill: {
                        fillEvents += 1;
                        continue;
                    }
                    case __1.EventType.Out: {
                        outEvents += 1;
                        continue;
                    }
                }
            }
            debug += `  fillEvents: ${fillEvents}\n`;
            debug += `  outEvents: ${outEvents}\n`;
        }
        else {
            debug += `  loaded: false\n`;
        }
        debug += ` minOrderSize: ${this.minOrderSize}\n`;
        debug += ` tickSize: ${this.tickSize}\n`;
        return debug;
    }
}
exports.Market = Market;
