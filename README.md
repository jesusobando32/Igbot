# Instagram Multi-Post Recurrent Automation Bot

Automatización en **Node.js + Playwright** con **Panel de Control Web Local** para iniciar sesión en Instagram (con persistencia en `sesion_ig.json`) y publicar comentarios recurrentes con etiquetado aleatorio sin repetición, tipeo humano letra por letra y tiempos anti-spam escalonados en segundo plano.

## ✨ Características Principales

- **Persistencia de Sesión (`storageState`)**: Guarda y reutiliza la sesión en `sesion_ig.json` sin necesidad de volver a iniciar sesión en cada ejecución.
- **Modo Manual sin Límite de Tiempo**: Permite resolver códigos 2FA o verificaciones iniciales sin cerrar el navegador por *timeout*.
- **Panel de Control Visual (`panel.html`)**:
  - Permite lanzar **uno o varios posts en paralelo**, cada uno con su propio mensaje (o vacío para enviar únicamente los etiquetados).
  - **Etiquetado Aleatorio sin Repetición**: Selecciona $N$ usuarios al azar de tu lista guardada (`usuarios_guardados.json`) usando el algoritmo *Fisher-Yates* sin repetir usuarios en el mismo comentario.
  - **Simulación Humana y Anti-Spam**: Tipeo carácter por carácter (`pressSequentially`), intervalos aleatorios entre mensajes, descansos largos por lotes y coordinador de turnos entre pestañas.
  - **Ejecución en Segundo Plano / Minimizado**: Trabaja minimizado en la barra de tareas sin robar el foco de Windows.

## 🚀 Instalación y Uso

1. Instalar dependencias y navegador:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. Configurar credenciales opcionales copiando `.env.example` a `.env`:
   ```bash
   cp .env.example .env
   ```

3. Iniciar el bot y abrir el Panel de Control:
   ```bash
   node comentar.js
   ```
