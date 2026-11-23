import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt } from '@earendil-works/pi-ai';

export function createReviewerProvider({ provider: providerId = 'offline-one', verdict = 'allow', delay } = {}) {
  const faux = fauxProvider({
    provider: providerId,
    api: `${providerId}-api`,
    models: ['model-one', 'model-two'].map(id => ({ id, input: ['text'], contextWindow: 1_000_000 })),
    tokenSize: { min: 1000, max: 1000 },
  });
  const state = { systemPrompts: [], models: [], get callCount() { return faux.state.callCount; } };
  function setVerdict(value) {
    if (value !== 'allow' && value !== 'deny') throw new Error(`Unknown reviewer verdict: ${value}`);
    verdict = value;
  }
  setVerdict(verdict);
  const respond = async (context) => {
    state.systemPrompts.push(getCurrentSystemPrompt(context.messages));
    const outcome = verdict;
    await delay;
    return fauxAssistantMessage(JSON.stringify({ outcome, rationale: `Offline reviewer: ${outcome}.` }));
  };
  const provider = {
    ...faux.provider,
    stream(model, context, options) {
      state.models.push({ provider: model.provider, id: model.id });
      faux.appendResponses([respond]);
      return faux.provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      state.models.push({ provider: model.provider, id: model.id });
      faux.appendResponses([respond]);
      return faux.provider.streamSimple(model, context, options);
    },
  };
  return { provider, state, setVerdict };
}
