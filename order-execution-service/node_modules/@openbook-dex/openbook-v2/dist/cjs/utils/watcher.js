"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Watcher = void 0;
const __1 = require("..");
class Watcher {
    connection;
    accountSubs = {};
    constructor(connection) {
        this.connection = connection;
    }
    addMarket(market, includeBook = true, includeEvents = true) {
        const { client, asks, bids, eventHeap, pubkey } = market;
        this.accountSubs[pubkey.toBase58()] = this.connection.onAccountChange(pubkey, (ai) => {
            market.account = client.program.coder.accounts.decode('market', ai.data);
        });
        if (includeBook && asks) {
            this.addBookSide(asks);
        }
        if (includeBook && bids) {
            this.addBookSide(bids);
        }
        if (includeEvents && eventHeap) {
            this.addEventHeap(eventHeap);
        }
        return this;
    }
    addBookSide(bookSide) {
        const { pubkey } = bookSide;
        this.accountSubs[pubkey.toBase58()] = this.connection.onAccountChange(pubkey, (ai) => {
            bookSide.account = __1.BookSide.decodeAccountfromBuffer(ai.data);
        });
        return this;
    }
    addEventHeap(eventHeap) {
        const { market, pubkey } = eventHeap;
        this.accountSubs[pubkey.toBase58()] = this.connection.onAccountChange(pubkey, (ai) => {
            eventHeap.account = market.client.program.coder.accounts.decode('eventHeap', ai.data);
        });
        return this;
    }
    addOpenOrders(openOrders) {
        const { market, pubkey } = openOrders;
        this.accountSubs[pubkey.toBase58()] = this.connection.onAccountChange(pubkey, (ai) => {
            openOrders.account = market.client.program.coder.accounts.decode('OpenOrders', ai.data);
        });
        return this;
    }
    clear() {
        for (const [_pk, sub] of Object.entries(this.accountSubs)) {
            this.connection.removeAccountChangeListener(sub);
        }
        return this;
    }
}
exports.Watcher = Watcher;
