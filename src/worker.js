export default {
  async fetch(request, env) {
    return new Response('AgentMeet — coming soon', { status: 200 });
  }
};

export class RoomDO {
  constructor(state, env) {
    this.state = state;
  }
  async fetch(request) {
    return new Response('Room stub', { status: 200 });
  }
}
