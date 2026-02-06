export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!anthropicKey && !openaiKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  // ── Try Anthropic first ──
  if (anthropicKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.json();

      if (response.ok) {
        data._provider = 'anthropic';
        return res.status(200).json(data);
      }

      // Check if it's a credit/rate limit error that warrants fallback to OpenAI
      const shouldFallback =
        response.status === 429 ||
        response.status === 529 ||
        data?.error?.type === 'rate_limit_error' ||
        data?.error?.type === 'overloaded_error' ||
        data?.error?.type === 'authentication_error' ||
        (data?.error?.message || '').toLowerCase().includes('credit') ||
        (data?.error?.message || '').toLowerCase().includes('quota') ||
        (data?.error?.message || '').toLowerCase().includes('billing');

      if (!shouldFallback || !openaiKey) {
        return res.status(response.status).json(data);
      }

      // Fall through to OpenAI fallback
    } catch (error) {
      if (!openaiKey) {
        return res.status(500).json({ error: error.message });
      }
      // Fall through to OpenAI fallback
    }
  }

  // ── Fallback to OpenAI (ChatGPT) ──
  if (!openaiKey) {
    return res.status(500).json({ error: 'No fallback API key configured' });
  }

  try {
    // Convert Anthropic message format to OpenAI format
    const messages = (req.body.messages || []).map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('\n')
          : String(m.content),
    }));

    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: req.body.max_tokens || 3000,
        messages,
      }),
    });

    const openaiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return res.status(openaiResponse.status).json({
        error: openaiData.error?.message || 'OpenAI API error',
      });
    }

    // Convert OpenAI response to Anthropic-compatible format
    const text = openaiData.choices?.[0]?.message?.content || '';

    return res.status(200).json({
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      model: openaiData.model || 'gpt-4o',
      _provider: 'openai',
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
