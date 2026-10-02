-- MySQL dump 10.13  Distrib 8.0.36
/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8mb4 */;
DROP TABLE IF EXISTS `orders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
CREATE TABLE `orders` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint NOT NULL COMMENT 'Customer',
  `order_no` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL COMMENT 'Order number',
  `status` enum('PENDING','PAID','CANCELED') NOT NULL DEFAULT 'PENDING',
  `amount` decimal(12,2) unsigned DEFAULT NULL,
  `note` text CHARACTER SET utf8mb4 COMMENT 'It\'s a "note"',
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  `key` varchar(64) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_no` (`order_no`),
  KEY `idx_user_id` (`user_id`),
  KEY `idx_user_status` (`user_id`,`status`),
  KEY `idx_note` (`note`(20)),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=10 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Customer orders';
/*!40101 SET character_set_client = @saved_cs_client */;
LOCK TABLES `orders` WRITE;
INSERT INTO `orders` VALUES (1,2,'A-1','PAID',10.00,'x; y',NOW(),NULL);
UNLOCK TABLES;
CREATE TABLE `order_items` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `order_id` bigint NOT NULL,
  `product_id` bigint NOT NULL,
  `qty` int(11) NOT NULL DEFAULT '1',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_order_product` (`order_id`,`product_id`),
  CONSTRAINT `fk_items_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`)
) ENGINE=InnoDB;
DROP TABLE IF EXISTS `v_orders`;
/*!50001 DROP VIEW IF EXISTS `v_orders`*/;
/*!50001 CREATE TABLE `v_orders` (
  `id` tinyint NOT NULL
) ENGINE=MyISAM */;
/*!50001 DROP TABLE IF EXISTS `v_orders`*/;
/*!50001 DROP VIEW IF EXISTS `v_orders`*/;
/*!50001 CREATE ALGORITHM=UNDEFINED */
/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */
/*!50001 VIEW `v_orders` AS select `orders`.`id` AS `id` from `orders` */;
DELIMITER ;;
CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()
BEGIN
  SELECT 1; SELECT 2;
END ;;
DELIMITER ;
