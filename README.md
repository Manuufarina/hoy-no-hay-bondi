# 🚍 Hoy No Hay Bondi

Monitor de paros de colectivos en Zona Norte del GBA (AMBA).

Diseñado por **Manuel Gonzalo Fariña Serra**

## Deploy en Vercel

### Opción 1: Desde GitHub (recomendado)

1. **Subí el proyecto a GitHub:**
   ```bash
   cd hoy-no-hay-bondi
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create hoy-no-hay-bondi --public --push
   ```
   O creá el repo manualmente en github.com y hacé push.

2. **Importá en Vercel:**
   - Andá a [vercel.com/new](https://vercel.com/new)
   - Clickeá **"Import Git Repository"**
   - Seleccioná el repo `hoy-no-hay-bondi`
   - En **Environment Variables** agregá:
     - Key: `ANTHROPIC_API_KEY`
     - Value: tu API key de Anthropic (la sacás de https://console.anthropic.com/)
   - Clickeá **Deploy**

### Opción 2: Desde la CLI de Vercel

```bash
npm i -g vercel
cd hoy-no-hay-bondi
npm install
vercel
# Seguí las instrucciones, elegí el proyecto
# Cuando pregunte por variables de entorno:
vercel env add ANTHROPIC_API_KEY
# Pegá tu API key
vercel --prod
```

## Desarrollo local

```bash
npm install
cp .env.example .env.local
# Editá .env.local con tu ANTHROPIC_API_KEY
npx vercel dev
```

> Usá `vercel dev` en vez de `npm run dev` para que funcione la serverless function `/api/chat`.

## Estructura

```
hoy-no-hay-bondi/
├── api/
│   └── chat.js          # Serverless function (proxy a Anthropic API)
├── src/
│   ├── App.jsx          # Componente principal
│   └── main.jsx         # Entry point
├── index.html
├── package.json
├── vite.config.js
├── vercel.json
└── .env.example
```

## Fuentes monitoreadas

- 📺 TN (tn.com.ar) — Principal
- 𝕏 @CiudadDeBondis — Principal
- 🚌 parodebondis.com.ar
- 📰 La Nación, Infobae, C5N, Canal 26, Infocielo, Página/12
- 🚦 alertastransito.com
