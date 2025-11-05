"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Order = void 0;
const anchor_1 = require("@coral-xyz/anchor");
const __1 = require("..");
class Order {
    market;
    leafNode;
    side;
    isExpired;
    isOraclePegged;
    seqNum;
    priceLots;
    constructor(market, leafNode, side, isExpired = false, isOraclePegged = false) {
        this.market = market;
        this.leafNode = leafNode;
        this.side = side;
        this.isExpired = isExpired;
        this.isOraclePegged = isOraclePegged;
        this.seqNum = this.side.bid
            ? __1.U64_MAX_BN.sub(this.leafNode.key.maskn(64))
            : this.leafNode.key.maskn(64);
        const priceData = this.leafNode.key.ushrn(64);
        if (this.isOraclePegged) {
            const priceOffset = priceData.sub(new anchor_1.BN(1).ushln(63));
            throw new Error('Not implemented yet');
            // TODO: add oracle price logic to Market
        }
        else {
            this.priceLots = priceData;
        }
    }
    get price() {
        return this.market.priceLotsToUi(this.priceLots);
    }
    get size() {
        return this.market.baseLotsToUi(this.leafNode.quantity);
    }
    get sizeLots() {
        return this.leafNode.quantity;
    }
    toPrettyString() {
        return `side:${this.side.bid ? 'bid' : 'ask'} price:${this.price} size:${this.size} seqNum:${this.seqNum.toString()} expired:${this.isExpired}`;
    }
}
exports.Order = Order;
