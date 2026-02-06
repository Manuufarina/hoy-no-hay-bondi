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

  // ── Fallback to OpenAI (ChatGPT) with web search ──
  if (!openaiKey) {
    return res.status(500).json({ error: 'No fallback API key configured' });
  }

  try {
    // Build input for OpenAI Responses API
    // Add a system message to force web search usage
    const userContent = (req.body.messages || []).map(m =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map(c => c.text || '').join('\n')
          : String(m.content)
    ).join('\n');

    const input = [
      {
        role: 'system',
        content: `Sos un asistente que monitorea paros de colectivos en Buenos Aires, Argentina.
REGLAS OBLIGATORIAS:
- SIEMPRE usá búsqueda web antes de responder. NUNCA respondas de memoria.
- Buscá ESPECÍFICAMENTE en: parodebondis.com.ar, tn.com.ar, infobae.com, lanacion.com.ar
- Hacé MÚLTIPLES búsquedas: "paro colectivos hoy buenos aires", "paro bondi hoy", "parodebondis.com.ar"
- Si encontrás paros, reportalos TODOS. No digas "no hay paros" si no buscaste primero.
- Respondé SOLO con JSON puro, sin markdown, sin backticks, sin texto extra.`
      },
      {
        role: 'user',
        content: userContent,
      }
    ];

    // Use OpenAI Responses API with web search enabled
    const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        input,
        tools: [{
          type: 'web_search_preview',
          user_location: {
            type: 'approximate',
            country: 'AR',
            city: 'Buenos Aires',
            region: 'Buenos Aires',
            timezone: 'America/Argentina/Buenos_Aires',
          },
          search_context_size: 'high',
        }],
      }),
    });

    const openaiData = await openaiResponse.json();

    if (!openaiResponse.ok) {
      return res.status(openaiResponse.status).json({
        error: openaiData.error?.message || 'OpenAI API error',
      });
    }

    // Extract text from Responses API output
    // output_text is a shortcut, or we can parse output array
    let text = openaiData.output_text || '';

    if (!text && openaiData.output) {
      for (const item of openaiData.output) {
        if (item.type === 'message' && item.content) {
          for (const block of item.content) {
            if (block.type === 'output_text' && block.text) {
              text += block.text;
            }
          }
        }
      }
    }

    // Convert to Anthropic-compatible format
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
