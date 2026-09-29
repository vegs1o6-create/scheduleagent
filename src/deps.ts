import type { CalendarApi } from "./calendar";
import type { ClaudeApi } from "./claude";
import type { Config } from "./env";
import type { Store } from "./store";
import type { Telegram } from "./telegram";

/** Alt handlerne trenger. Samlet her slik at testene kan bytte ut deler. */
export interface Deps {
  config: Config;
  store: Store;
  telegram: Pick<
    Telegram,
    "sendMessage" | "editMessage" | "removeKeyboard" | "answerCallback" | "sendChatAction" | "downloadFile"
  >;
  calendar: CalendarApi;
  claude: ClaudeApi;
  chatId: string;
  now: () => Date;
}
