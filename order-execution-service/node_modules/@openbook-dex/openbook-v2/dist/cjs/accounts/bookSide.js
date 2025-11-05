"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BookSide = void 0;
const __1 = require("..");
const anchor_1 = require("@coral-xyz/anchor");
const order_1 = require("../structs/order");
function decodeOrderTreeRootStruct(data) {
    const maybeNode = data.readUInt32LE(0);
    const leafCount = data.readUInt32LE(4);
    return { maybeNode, leafCount };
}
class BookSide {
    market;
    pubkey;
    account;
    side;
    clusterTime;
    constructor(market, pubkey, account, side) {
        this.market = market;
        this.pubkey = pubkey;
        this.account = account;
        this.side = side;
        this.clusterTime = new anchor_1.BN(0);
    }
    static decodeAccountfromBuffer(data) {
        // TODO: add discriminator parsing & check
        const roots = [
            decodeOrderTreeRootStruct(data.subarray(8)),
            decodeOrderTreeRootStruct(data.subarray(16)),
        ];
        // skip reserved
        let offset = 56 + 256;
        const orderTreeType = data.readUInt8(offset);
        const bumpIndex = data.readUInt32LE(offset + 4);
        const freeListLen = data.readUInt32LE(offset + 8);
        const freeListHead = data.readUInt32LE(offset + 12);
        // skip more reserved data
        offset += 16 + 512;
        const nodes = [];
        for (let i = 0; i < 1024; ++i) {
            const tag = data.readUInt8(offset);
            const nodeData = data.subarray(offset, offset + 88);
            nodes.push({ tag, nodeData });
            offset += 88;
        }
        // this result has a slightly different layout than the regular account
        // it doesn't include reserved data and it's AnyNodes don't have the field
        // data: number[] (excluding the tag prefix byte)
        // but nodeData: Buffer (including the tag prefix byte)
        const result = {
            roots,
            nodes: { orderTreeType, bumpIndex, freeListLen, freeListHead, nodes },
        };
        return result;
    }
    *items() {
        const fGen = this.fixedItems();
        const oPegGen = this.oraclePeggedItems();
        let fOrderRes = fGen.next();
        let oPegOrderRes = oPegGen.next();
        while (true) {
            if (fOrderRes.value && oPegOrderRes.value) {
                if (this.compareOrders(fOrderRes.value, oPegOrderRes.value)) {
                    yield fOrderRes.value;
                    fOrderRes = fGen.next();
                }
                else {
                    yield oPegOrderRes.value;
                    oPegOrderRes = oPegGen.next();
                }
            }
            else if (fOrderRes.value && !oPegOrderRes.value) {
                yield fOrderRes.value;
                fOrderRes = fGen.next();
            }
            else if (!fOrderRes.value && oPegOrderRes.value) {
                yield oPegOrderRes.value;
                oPegOrderRes = oPegGen.next();
            }
            else if (!fOrderRes.value && !oPegOrderRes.value) {
                break;
            }
        }
    }
    get rootFixed() {
        return this.account.roots[0];
    }
    get rootOraclePegged() {
        return this.account.roots[1];
    }
    *fixedItems() {
        if (this.rootFixed.leafCount === 0) {
            return;
        }
        const stack = [this.rootFixed.maybeNode];
        const [left, right] = this.side.bid ? [1, 0] : [0, 1];
        while (stack.length > 0) {
            const index = stack.pop();
            const node = this.account.nodes.nodes[index];
            if (node.tag === BookSide.INNER_NODE_TAG) {
                const innerNode = this.toInnerNode(node);
                stack.push(innerNode.children[right], innerNode.children[left]);
            }
            else if (node.tag === BookSide.LEAF_NODE_TAG) {
                const leafNode = this.toLeafNode(node);
                const expiryTimestamp = leafNode.timeInForce
                    ? leafNode.timestamp.add(new anchor_1.BN(leafNode.timeInForce))
                    : __1.U64_MAX_BN;
                yield new order_1.Order(this.market, leafNode, this.side, this.clusterTime.gt(expiryTimestamp));
            }
        }
    }
    *oraclePeggedItems() {
        if (this.rootOraclePegged.leafCount === 0) {
            return;
        }
        const stack = [this.rootOraclePegged.maybeNode];
        const [left, right] = this.side.bid ? [1, 0] : [0, 1];
        while (stack.length > 0) {
            const index = stack.pop();
            const node = this.account.nodes.nodes[index];
            if (node.tag === BookSide.INNER_NODE_TAG) {
                const innerNode = this.toInnerNode(node);
                stack.push(innerNode.children[right], innerNode.children[left]);
            }
            else if (node.tag === BookSide.LEAF_NODE_TAG) {
                const leafNode = this.toLeafNode(node);
                const expiryTimestamp = leafNode.timeInForce
                    ? leafNode.timestamp.add(new anchor_1.BN(leafNode.timeInForce))
                    : __1.U64_MAX_BN;
                yield new order_1.Order(this.market, leafNode, this.side, this.clusterTime.gt(expiryTimestamp), true);
            }
        }
    }
    compareOrders(a, b) {
        return a.priceLots.eq(b.priceLots)
            ? a.seqNum.lt(b.seqNum) // if prices are equal prefer orders in the order they are placed
            : this.side.bid // else compare the actual prices
                ? a.priceLots.gt(b.priceLots)
                : b.priceLots.gt(a.priceLots);
    }
    best() {
        return this.items().next().value;
    }
    getL2(depth) {
        const levels = [];
        for (const { priceLots, sizeLots } of this.items()) {
            if (levels.length > 0 && levels[levels.length - 1][0].eq(priceLots)) {
                levels[levels.length - 1][1].iadd(sizeLots);
            }
            else if (levels.length === depth) {
                break;
            }
            else {
                levels.push([priceLots, sizeLots]);
            }
        }
        return levels.map(([priceLots, sizeLots]) => [
            this.market.priceLotsToUi(priceLots),
            this.market.baseLotsToUi(sizeLots),
            priceLots,
            sizeLots,
        ]);
    }
    static INNER_NODE_TAG = 1;
    static LEAF_NODE_TAG = 2;
    toInnerNode(node) {
        const layout = this.market.client.program._coder.types.typeLayouts.get('InnerNode');
        // need to differentiate between accounts loaded via anchor and decodeAccountfromBuffer
        if ('nodeData' in node) {
            return layout.decode(node['nodeData']);
        }
        else {
            return layout.decode(Buffer.from([BookSide.INNER_NODE_TAG].concat(node.data)));
        }
    }
    toLeafNode(node) {
        const layout = this.market.client.program._coder.types.typeLayouts.get('LeafNode');
        // need to differentiate between accounts loaded via anchor and decodeAccountfromBuffer
        if ('nodeData' in node) {
            return layout.decode(node['nodeData']);
        }
        else {
            return layout.decode(Buffer.from([BookSide.LEAF_NODE_TAG].concat(node.data)));
        }
    }
}
exports.BookSide = BookSide;
