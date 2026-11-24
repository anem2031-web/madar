export type AccessFailureHandlers = {
  onSessionInvalid: () => void;
  onReadForbidden: (requestId?: string) => void;
  onActionForbidden: () => void;
};
