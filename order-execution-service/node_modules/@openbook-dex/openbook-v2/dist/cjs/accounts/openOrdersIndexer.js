"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenOrdersIndexer = void 0;
const __1 = require("..");
class OpenOrdersIndexer {
    client;
    pubkey;
    account;
    constructor(client, pubkey, account) {
        this.client = client;
        this.pubkey = pubkey;
        this.account = account;
    }
    static async load(client, owner) {
        const pubkey = client.findOpenOrdersIndexer(owner);
        const account = await client.program.account.openOrdersIndexer.fetch(pubkey);
        return new OpenOrdersIndexer(client, pubkey, account);
    }
    static async loadNullable(client, owner) {
        const pubkey = client.findOpenOrdersIndexer(owner);
        const account = await client.program.account.openOrdersIndexer.fetchNullable(pubkey);
        return account && new OpenOrdersIndexer(client, pubkey, account);
    }
    async loadAllOpenOrders() {
        const ooPks = this.account.addresses;
        const oos = await this.client.program.account.openOrdersAccount.fetchMultiple(ooPks);
        const marketPks = oos.map((oo) => oo.market);
        const markets = await this.client.program.account.market.fetchMultiple(marketPks);
        const bookSidePks = markets.flatMap((m) => [m.bids, m.asks]);
        const bookSideAis = await this.client.connection.getMultipleAccountsInfo(bookSidePks);
        return oos.map((oo, i) => {
            const mkt = new __1.Market(this.client, marketPks[i], markets[i]);
            mkt.bids = new __1.BookSide(mkt, bookSidePks[2 * i], __1.BookSide.decodeAccountfromBuffer(bookSideAis[2 * i].data), __1.SideUtils.Bid);
            mkt.asks = new __1.BookSide(mkt, bookSidePks[2 * i + 1], __1.BookSide.decodeAccountfromBuffer(bookSideAis[2 * i + 1].data), __1.SideUtils.Ask);
            return new __1.OpenOrders(ooPks[i], oo, mkt);
        });
    }
}
exports.OpenOrdersIndexer = OpenOrdersIndexer;
