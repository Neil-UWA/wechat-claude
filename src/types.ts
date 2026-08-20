export type QRCodeResponse = {
  qrcode: string;
  qrcode_img_content: string;
};

export type QRCodeStatus = "wait" | "scaned" | "confirmed" | "expired";

export type QRCodeStatusResponse = {
  status: QRCodeStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
};

export type BaseInfo = {
  channel_version: string;
};

export type CDNMedia = {
  encrypt_query_param: string;
  aes_key: string;
  encrypt_type: number;
};

export type TextItem = {
  type: 1;
  text_item: { text: string };
};

export type ImageItem = {
  type: 2;
  image_item: {
    media: CDNMedia;
    thumb_media?: CDNMedia;
    aeskey?: string;
    url?: string;
    thumb_height?: number;
    thumb_width?: number;
  };
};

export type VoiceItem = {
  type: 3;
  voice_item: {
    media: CDNMedia;
    encode_type: number;
    bits_per_sample?: number;
    sample_rate?: number;
    playtime?: number;
    text?: string;
  };
};

export type FileItem = {
  type: 4;
  file_item: {
    media: CDNMedia;
    file_name: string;
    md5: string;
    len: string;
  };
};

export type VideoItem = {
  type: 5;
  video_item: {
    media: CDNMedia;
    video_size: number;
    play_length: number;
    video_md5: string;
    thumb_media?: CDNMedia;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
  };
};

export type MessageItem = TextItem | ImageItem | VoiceItem | FileItem | VideoItem;

export type WeixinMessage = {
  seq: number;
  message_id: string;
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  create_time_ms: number;
  update_time_ms: number;
  delete_time_ms: number;
  session_id: string;
  group_id: string;
  message_type: 1 | 2;
  message_state: 0 | 1 | 2;
  context_token: string;
  item_list: MessageItem[];
};

export type GetUpdatesResponse = {
  ret: number;
  msgs: WeixinMessage[];
  get_updates_buf: string;
  longpolling_timeout_ms: number;
};

export type GetConfigResponse = {
  ret: number;
  typing_ticket: string;
};

export type SendTypingRequest = {
  ilink_user_id: string;
  typing_ticket: string;
  status: 1 | 2;
  base_info: BaseInfo;
};

export type SendMessageRequest = {
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: 2;
    message_state: 2;
    context_token: string;
    item_list: MessageItem[];
  };
  base_info: BaseInfo;
};

export type GetUploadUrlRequest = {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
  base_info: BaseInfo;
};

export type GetUploadUrlResponse = {
  upload_param?: string;
  upload_full_url?: string;
};

export type UploadedMedia = {
  downloadParam: string;
  aesKeyHex: string;
  fileSize: number;
  ciphertextSize: number;
};

export type Session = {
  botToken: string;
  ilinkBotId: string;
  ilinkUserId: string;
  baseUrl: string;
};

export type PendingMessage = {
  id: string;
  fromUserId: string;
  text: string;
  contextToken: string;
  timestamp: number;
  rawItems: MessageItem[];
};
