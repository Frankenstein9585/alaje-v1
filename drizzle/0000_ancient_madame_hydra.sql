CREATE TABLE `businesses` (
	`id` varchar(36) NOT NULL,
	`whatsapp_number` varchar(32) NOT NULL,
	`name` varchar(120),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `businesses_id` PRIMARY KEY(`id`),
	CONSTRAINT `businesses_whatsapp_number_idx` UNIQUE(`whatsapp_number`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`normalized_name` varchar(160) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `customers_business_normalized_name_idx` UNIQUE(`business_id`,`normalized_name`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`wa_message_id` varchar(128),
	`role` enum('user','assistant') NOT NULL,
	`content` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`id` varchar(36) NOT NULL,
	`wa_message_id` varchar(128) NOT NULL,
	`processed_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `processed_messages_id` PRIMARY KEY(`id`),
	CONSTRAINT `processed_messages_wa_message_id_idx` UNIQUE(`wa_message_id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`normalized_name` varchar(160) NOT NULL,
	`unit` varchar(32),
	`stock_qty` int NOT NULL DEFAULT 0,
	`low_stock_threshold` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_business_normalized_name_idx` UNIQUE(`business_id`,`normalized_name`)
);
--> statement-breakpoint
CREATE TABLE `tool_call_logs` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`tool_name` varchar(64) NOT NULL,
	`arguments` json,
	`result` json,
	`success` boolean NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `tool_call_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` varchar(36) NOT NULL,
	`business_id` varchar(36) NOT NULL,
	`type` enum('sale','expense','payment') NOT NULL,
	`amount` decimal(14,2) NOT NULL,
	`product_ref` varchar(36),
	`customer_id` varchar(36),
	`quantity` int,
	`source` enum('typed','ocr') NOT NULL DEFAULT 'typed',
	`voided_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `transactions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `messages_business_created_at_idx` ON `messages` (`business_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tool_call_logs_business_idx` ON `tool_call_logs` (`business_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `transactions_business_created_at_idx` ON `transactions` (`business_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `transactions_business_customer_idx` ON `transactions` (`business_id`,`customer_id`);