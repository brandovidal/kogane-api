# Monedas de los estados de cuenta

## Modelo

- `cat_currencies` contiene el catálogo compartido PEN (Soles, S/) y USD (Dólares, US$).
- `imp_statement_balances` guarda un registro por estado y moneda: total, mínimo, saldo anterior, pagos anteriores, pago del mes y reparto del mínimo. La combinación `statementId + currency` es única, la moneda referencia el catálogo y el estado elimina sus saldos en cascada.
- Los saldos llevan `userId`; la extensión de tenencia los limita al usuario de la sesión. El catálogo ISO es compartido y no contiene datos personales.
- Los campos escalares de `imp_statements` se conservan por compatibilidad y representan la moneda principal (PEN cuando está presente). Los consumidores nuevos usan `balances`.

## Reconocimiento y comparación

El lector toma la moneda de símbolos, secciones o columnas del PDF. Si el formato es ambiguo, delega la lectura a la IA. Los resúmenes por moneda de la IA prevalecen sobre una lectura parcial de columnas. No se identifica la moneda por el nombre o país del comercio y no se convierten importes automáticamente.

Las coincidencias, anulaciones, cargos, pagos y diferencias se calculan entre importes de la misma moneda. Dos compras iguales en monedas distintas se conservan como movimientos distintos. Un total no identificado se devuelve como `null`, nunca como cero.

`GET /v1/statements/:id` incluye `balances[]` con `koganeTotal` y `difference` por moneda. `GET /v1/debts/card-check` acepta `currency=PEN|USD` (PEN por defecto). `PATCH /v1/statements/:id` acepta `currency` al guardar `minimumDue` o `minimumAllocations`; sin ella se conserva la compatibilidad con la moneda principal.

Los avisos de calendario nuevos incluyen la moneda en su referencia (`tarjeta@AAAA-MM:USD`): marcar uno como pagado afecta solo a los gastos de esa moneda. Las referencias anteriores siguen siendo válidas.

## Migración y estados anteriores

La migración `20260927200000_statement_currency_balances` es aditiva: crea el catálogo y los saldos, copia los valores históricos y marca los estados existentes con `currencyReviewRequired=true`.

Los valores antiguos no permiten deducir con seguridad si una columna del PDF se leyó mal. Por eso se conservan y la interfaz pide volver a cargar el PDF. La nueva lectura genera una nueva revisión y contrasta sus movimientos con los gastos existentes. Los gastos ya guardados no cambian de moneda automáticamente: deben revisarse para evitar duplicarlos al aprobar la nueva lectura.

Aplicación local: `pnpm exec dotenv -e .env.dev -- prisma migrate deploy`, seguido de `pnpm exec prisma generate`. Producción usa el flujo habitual `scripts/db-deploy.ts`; esta tarea no aplicó cambios a Turso.
