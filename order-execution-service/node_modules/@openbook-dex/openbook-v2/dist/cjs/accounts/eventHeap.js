"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventHeap = exports.EventType = void 0;
var EventType;
(function (EventType) {
    EventType[EventType["Fill"] = 0] = "Fill";
    EventType[EventType["Out"] = 1] = "Out";
})(EventType || (exports.EventType = EventType = {}));
class EventHeap {
    pubkey;
    account;
    market;
    constructor(pubkey, account, market) {
        this.pubkey = pubkey;
        this.account = account;
        this.market = market;
    }
    *rawEvents() {
        let currentIndex = this.account.header.usedHead;
        for (let i = 0; i < this.account.header.count; ++i) {
            const { event, next } = this.account.nodes[currentIndex];
            yield event;
            currentIndex = next;
        }
    }
    *parsedEvents() {
        const { decode } = this.market.client.program.coder.types;
        for (const event of this.rawEvents()) {
            // TODO find out how not to re-allocate
            const buffer = Buffer.from([event.eventType].concat(event.padding));
            switch (event.eventType) {
                case EventType.Fill: {
                    yield decode('FillEvent', buffer);
                    continue;
                }
                case EventType.Out: {
                    yield decode('OutEvent', buffer);
                    continue;
                }
            }
        }
    }
}
exports.EventHeap = EventHeap;
