SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Users](
	[Id] [int] IDENTITY(1,1) NOT NULL,
	[Email] [nvarchar](255) NOT NULL,
	[DisplayName] [nvarchar](max) NULL,
	[Status] [varchar](10) NOT NULL CONSTRAINT [CK_Users_Status] CHECK ([Status]='ACTIVE' OR [Status]='BLOCKED'),
 CONSTRAINT [PK_Users] PRIMARY KEY CLUSTERED 
(
	[Id] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
CREATE TABLE [dbo].[Order Details](
	[OrderId] [int] NOT NULL,
	[UserId] [int] NOT NULL,
	[Total] AS ([Qty]*[Price]) PERSISTED,
	[Qty] [int] NOT NULL CONSTRAINT [DF_Qty] DEFAULT ((1)),
	[Price] [decimal](10, 2) NOT NULL
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[Order Details]  WITH CHECK ADD  CONSTRAINT [FK_Details_Users] FOREIGN KEY([UserId])
REFERENCES [dbo].[Users] ([Id])
GO
ALTER TABLE [dbo].[Order Details] CHECK CONSTRAINT [FK_Details_Users]
GO
CREATE NONCLUSTERED INDEX [IX_Details_User] ON [dbo].[Order Details]
(
	[UserId] ASC
) INCLUDE ([Qty]) WITH (SORT_IN_TEMPDB = OFF) ON [PRIMARY]
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'People who sign in' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Users'
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Login address' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Users', @level2type=N'COLUMN',@level2name=N'Email'
GO
